"use strict";

/**
 * SOVEREIGN NET OS — Absolute Kernel v2
 *
 * Architecture: Everything mutates state through dispatch().
 * No direct access to DAG, SharedState, BlockStore, or SigPipeline.
 * All transitions: validated → costed → applied → recorded → emitted.
 *
 *   External Input (UI / Network / IPC)
 *           ↓
 *      SigPipeline.verify
 *           ↓
 *      kernel.dispatch(event)
 *           ↓
 *      _consume(cost)
 *           ↓
 *      handler(state, event)
 *           ↓
 *      record(history)
 *           ↓
 *      emit effects (IPFS, network, UI)
 */

// ─────────────────────────────────────────────────────────────────────────────
// ABSOLUTE KERNEL (base: deterministic, bounded, replayable)
// ─────────────────────────────────────────────────────────────────────────────

class AbsoluteKernel {
  constructor({
    maxUnits  = 100_000,
    maxDepth  = 64,
    pulseSize = 1,
    seed      = 0,
  } = {}) {
    this.constraints = Object.freeze({ maxUnits, maxDepth, pulseSize });
    this.clock       = 0;
    this.unitsUsed   = 0;

    // Internal state containers — not accessible outside this class
    this._density   = new Map();   // key → value  (general state)
    this._relations = new Set();   // transition rules
    this.history    = [];          // append-only event log

    this._rngState  = seed >>> 0;
    this.random     = this._rng();
  }

  _rng() {
    return () => {
      this._rngState = (this._rngState + 0x6D2B79F5) | 0;
      let t = Math.imul(this._rngState ^ (this._rngState >>> 15), 1 | this._rngState);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  _consume(units) {
    this.unitsUsed += units;
    if (this.unitsUsed > this.constraints.maxUnits) {
      throw new KernelError("CONSTRAINT_VIOLATED", `maxUnits (${this.constraints.maxUnits}) exceeded`);
    }
  }

  _record(type, payload) {
    const entry = { t: this.clock, type, payload };
    this.history.push(entry);
    return entry;
  }

  replay() {
    return JSON.parse(JSON.stringify(this.history));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// KERNEL ERROR
// ─────────────────────────────────────────────────────────────────────────────

class KernelError extends Error {
  constructor(code, message) {
    super(message);
    this.name  = "KernelError";
    this.code  = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SIG PIPELINE  (validation layer — sits before dispatch)
// ─────────────────────────────────────────────────────────────────────────────

class SigPipeline {
  constructor() {
    this._validators = [];
  }

  /** Register a validation step. fn(event) → true | throws KernelError */
  use(fn) {
    this._validators.push(fn);
    return this;
  }

  verify(event) {
    for (const fn of this._validators) {
      fn(event); // throws on failure
    }
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPATCH KERNEL (the gate — wraps AbsoluteKernel)
// ─────────────────────────────────────────────────────────────────────────────

class DispatchKernel extends AbsoluteKernel {
  constructor(opts = {}) {
    super(opts);

    this._handlers  = new Map();  // eventType → handler fn
    this._effects   = new Map();  // eventType → [effect fn, ...]
    this._listeners = [];         // all-dispatch listeners
    this.sig        = new SigPipeline();

    // ── Internal state stores (not directly readable) ──────────────────────
    this._dag        = { nodes: new Map(), edges: new Map() };   // DAG
    this._state      = new Map();                                // SharedState
    this._blocks     = new Map();                                // BlockStore
    this._peerRep    = new Map();                                // Peer reputation
    this._bwLimits   = { upload: 0, download: 0 };              // BW constraints

    // ── Register built-in command handlers ────────────────────────────────
    this._registerBuiltins();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DISPATCH — the single entry point for all state mutations
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Dispatch an event through the kernel.
   *
   * @param {{ type: string, payload?: any, sig?: string, origin?: string }} event
   * @returns {{ ok: boolean, result?: any, error?: string, entry: object }}
   */
  dispatch(event) {
    if (!event || typeof event.type !== "string") {
      throw new KernelError("INVALID_EVENT", "event.type must be a string");
    }

    const evt = {
      type:    event.type,
      payload: event.payload ?? {},
      sig:     event.sig     ?? null,
      origin:  event.origin  ?? "internal",
      id:      this._uid(),
    };

    // ── 1. Validate ─────────────────────────────────────────────────────────
    try {
      this.sig.verify(evt);
    } catch (err) {
      const entry = this._record("DISPATCH_REJECTED", { event: evt, reason: err.message });
      return { ok: false, error: err.message, entry };
    }

    // ── 2. Find handler ─────────────────────────────────────────────────────
    const handler = this._handlers.get(evt.type);
    if (!handler) {
      const entry = this._record("DISPATCH_UNKNOWN", { event: evt });
      return { ok: false, error: `No handler for event type: ${evt.type}`, entry };
    }

    // ── 3. Constrained execution ────────────────────────────────────────────
    try {
      this._consume(handler.cost ?? 1);
    } catch (err) {
      const entry = this._record("DISPATCH_THROTTLED", { event: evt, reason: err.message });
      return { ok: false, error: err.message, entry };
    }

    // ── 4. Apply ─────────────────────────────────────────────────────────────
    let result;
    try {
      result = handler.fn.call(this, evt.payload, evt);
    } catch (err) {
      const entry = this._record("DISPATCH_FAILED", { event: evt, reason: err.message });
      return { ok: false, error: err.message, entry };
    }

    // ── 5. Record ────────────────────────────────────────────────────────────
    const entry = this._record(evt.type, { payload: evt.payload, result });

    // ── 6. Emit effects ──────────────────────────────────────────────────────
    this.clock++;
    this._notify(evt, result, entry);

    return { ok: true, result, entry };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // REGISTER — add a command handler
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * @param {string}   type     - event type string
   * @param {function} fn       - handler(payload, event) → result
   * @param {object}   [opts]   - { cost: number }
   */
  register(type, fn, { cost = 1 } = {}) {
    if (this._handlers.has(type)) {
      throw new KernelError("HANDLER_EXISTS", `Handler for "${type}" already registered`);
    }
    this._handlers.set(type, { fn, cost });
    return this;
  }

  /** Override an existing handler (for extending built-ins) */
  override(type, fn, opts = {}) {
    this._handlers.delete(type);
    return this.register(type, fn, opts);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // EFFECTS — side-effect hooks (read-only, after commit)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Register an effect to run after a specific event type commits.
   * Effects cannot mutate state — they are side-effects (IPC, network, UI).
   */
  effect(type, fn) {
    if (!this._effects.has(type)) this._effects.set(type, []);
    this._effects.get(type).push(fn);
    return this;
  }

  /** Listen to all dispatched events */
  on(fn) {
    this._listeners.push(fn);
    return this;
  }

  _notify(evt, result, entry) {
    const effects = this._effects.get(evt.type) || [];
    for (const fn of effects) {
      try { fn(result, entry, evt); } catch (e) { /* effects must not crash the kernel */ }
    }
    for (const fn of this._listeners) {
      try { fn(evt, result, entry); } catch (e) {}
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // READ — safe read access (no mutation)
  // ──────────────────────────────────────────────────────────────────────────

  query(type, ...args) {
    const q = this._queries.get(type);
    if (!q) throw new KernelError("UNKNOWN_QUERY", `No query: ${type}`);
    return q.call(this, ...args);
  }

  get _queries() {
    if (!this.__queries) {
      this.__queries = new Map([
        ["STATE_GET",    (key)    => this._state.get(key)],
        ["STATE_ALL",    ()       => Object.fromEntries(this._state)],
        ["DAG_NODE",     (id)     => this._dag.nodes.get(id)],
        ["DAG_EDGES",    (id)     => Array.from(this._dag.edges.get(id) || [])],
        ["BLOCK_GET",    (cid)    => this._blocks.get(cid)],
        ["PEER_REP",     (peerId) => this._peerRep.get(peerId) ?? { score: 0, events: [], banned: false }],
        ["PEER_REP_ALL", ()       => Object.fromEntries(this._peerRep)],
        ["BW_LIMITS",    ()       => ({ ...this._bwLimits })],
        ["HISTORY",      ()       => this.replay()],
        ["CLOCK",        ()       => this.clock],
        ["UNITS_USED",   ()       => this.unitsUsed],
      ]);
    }
    return this.__queries;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SNAPSHOT / RESTORE
  // ──────────────────────────────────────────────────────────────────────────

  snapshot() {
    return {
      clock:     this.clock,
      unitsUsed: this.unitsUsed,
      state:     Object.fromEntries(this._state),
      dag: {
        nodes: Object.fromEntries(this._dag.nodes),
        edges: Object.fromEntries(
          Array.from(this._dag.edges.entries()).map(([k, v]) => [k, Array.from(v)])
        ),
      },
      blocks:   Object.fromEntries(this._blocks),
      peerRep:  Object.fromEntries(this._peerRep),
      bwLimits: { ...this._bwLimits },
      history:  this.replay(),
    };
  }

  restore(snap) {
    this.clock       = snap.clock ?? 0;
    this.unitsUsed   = snap.unitsUsed ?? 0;
    this._state      = new Map(Object.entries(snap.state ?? {}));
    this._blocks     = new Map(Object.entries(snap.blocks ?? {}));
    this._peerRep    = new Map(Object.entries(snap.peerRep ?? {}));
    this._bwLimits   = snap.bwLimits ?? { upload: 0, download: 0 };
    this._dag.nodes  = new Map(Object.entries(snap.dag?.nodes ?? {}));
    this._dag.edges  = new Map(
      Object.entries(snap.dag?.edges ?? {}).map(([k, v]) => [k, new Set(v)])
    );
    this.history = snap.history ?? [];
  }

  // ──────────────────────────────────────────────────────────────────────────
  // BUILT-IN HANDLERS
  // ──────────────────────────────────────────────────────────────────────────

  _registerBuiltins() {

    // ── SharedState ─────────────────────────────────────────────────────────

    this.register("STATE_SET", ({ key, value }) => {
      if (!key) throw new KernelError("INVALID_PAYLOAD", "STATE_SET requires key");
      const prev = this._state.get(key);
      this._state.set(key, value);
      return { key, prev, value };
    });

    this.register("STATE_DELETE", ({ key }) => {
      const prev = this._state.get(key);
      this._state.delete(key);
      return { key, prev };
    });

    this.register("STATE_MERGE", ({ key, patch }) => {
      if (!key || typeof patch !== "object") throw new KernelError("INVALID_PAYLOAD", "STATE_MERGE requires key+patch object");
      const prev = this._state.get(key) ?? {};
      const next = { ...prev, ...patch };
      this._state.set(key, next);
      return { key, prev, next };
    });

    // ── DAG ─────────────────────────────────────────────────────────────────

    this.register("DAG_COMMIT", ({ id, data, parents = [] }, { cost: _c } = {}) => {
      if (!id) throw new KernelError("INVALID_PAYLOAD", "DAG_COMMIT requires id");
      if (this._dag.nodes.has(id)) throw new KernelError("DAG_CONFLICT", `Node ${id} already exists`);
      this._dag.nodes.set(id, { id, data, parents, ts: this.clock });
      for (const p of parents) {
        if (!this._dag.edges.has(p)) this._dag.edges.set(p, new Set());
        this._dag.edges.get(p).add(id);
      }
      return { id, parents };
    }, { cost: 2 });

    this.register("DAG_MERGE", ({ base, head, resolver }) => {
      if (!this._dag.nodes.has(base)) throw new KernelError("DAG_MISSING", `Base node ${base} not found`);
      if (!this._dag.nodes.has(head)) throw new KernelError("DAG_MISSING", `Head node ${head} not found`);
      const baseNode = this._dag.nodes.get(base);
      const headNode = this._dag.nodes.get(head);
      const mergedId = `merge:${base}:${head}`;
      const mergedData = resolver ? resolver(baseNode.data, headNode.data) : { ...baseNode.data, ...headNode.data };
      this._dag.nodes.set(mergedId, { id: mergedId, data: mergedData, parents: [base, head], ts: this.clock });
      if (!this._dag.edges.has(base)) this._dag.edges.set(base, new Set());
      if (!this._dag.edges.has(head)) this._dag.edges.set(head, new Set());
      this._dag.edges.get(base).add(mergedId);
      this._dag.edges.get(head).add(mergedId);
      return { mergedId, base, head };
    }, { cost: 3 });

    // ── BlockStore ───────────────────────────────────────────────────────────

    this.register("BLOCK_PUT", ({ cid, data, meta = {} }) => {
      if (!cid) throw new KernelError("INVALID_PAYLOAD", "BLOCK_PUT requires cid");
      if (this._blocks.has(cid)) return { cid, duplicate: true }; // idempotent
      this._blocks.set(cid, { cid, data, meta, ts: this.clock });
      return { cid, size: meta.size ?? (typeof data === "string" ? data.length : 0) };
    });

    this.register("BLOCK_PIN", ({ cid }) => {
      const block = this._blocks.get(cid);
      if (!block) throw new KernelError("BLOCK_MISSING", `CID ${cid} not in store`);
      block.pinned = true;
      return { cid, pinned: true };
    });

    this.register("BLOCK_DELETE", ({ cid }) => {
      const block = this._blocks.get(cid);
      if (!block) throw new KernelError("BLOCK_MISSING", `CID ${cid} not in store`);
      if (block.pinned) throw new KernelError("BLOCK_PINNED", `Cannot delete pinned block ${cid}`);
      this._blocks.delete(cid);
      return { cid };
    });

    // ── Peer Reputation ──────────────────────────────────────────────────────

    const REP_BAN_THRESHOLD  = -20;
    const REP_GOOD_THRESHOLD = 50;

    this.register("PEER_REP_EVENT", ({ peerId, type: evtType, delta }) => {
      if (!peerId || typeof delta !== "number") throw new KernelError("INVALID_PAYLOAD", "PEER_REP_EVENT requires peerId+delta");
      if (!this._peerRep.has(peerId)) {
        this._peerRep.set(peerId, { score: 0, events: [], banned: false });
      }
      const rep = this._peerRep.get(peerId);
      rep.score = Math.max(-100, Math.min(100, rep.score + delta));
      rep.events.push({ t: this.clock, type: evtType, delta });
      if (rep.events.length > 50) rep.events.shift();
      const wasBanned = rep.banned;
      if (!rep.banned && rep.score <= REP_BAN_THRESHOLD) rep.banned = true;
      rep.trusted = rep.score >= REP_GOOD_THRESHOLD;
      return { peerId, score: rep.score, banned: rep.banned, freshBan: !wasBanned && rep.banned };
    });

    this.register("PEER_REP_DECAY", () => {
      let changed = 0;
      for (const [, rep] of this._peerRep) {
        if (rep.score > 0) { rep.score = Math.max(0, rep.score - 1); changed++; }
        if (rep.score < 0) { rep.score = Math.min(0, rep.score + 1); changed++; }
      }
      return { decayed: changed };
    }, { cost: 0 });

    this.register("PEER_BAN", ({ peerId, ban }) => {
      if (!this._peerRep.has(peerId)) this._peerRep.set(peerId, { score: 0, events: [], banned: false });
      const rep = this._peerRep.get(peerId);
      rep.banned = !!ban;
      if (ban) rep.score = Math.min(rep.score, REP_BAN_THRESHOLD);
      return { peerId, banned: rep.banned, score: rep.score };
    });

    // ── Bandwidth Constraints ────────────────────────────────────────────────

    this.register("BW_SET_LIMITS", ({ upload = 0, download = 0 }) => {
      this._bwLimits.upload   = Math.max(0, upload);
      this._bwLimits.download = Math.max(0, download);
      return { ...this._bwLimits };
    });

    // ── Identity / Session ───────────────────────────────────────────────────

    this.register("IDENTITY_SET", ({ did, handle, peerId }) => {
      if (!did) throw new KernelError("INVALID_PAYLOAD", "IDENTITY_SET requires did");
      this._state.set("identity", { did, handle: handle ?? peerId?.slice(0, 12), peerId });
      return { did, handle };
    });

    // ── Kernel reset ─────────────────────────────────────────────────────────

    this.register("KERNEL_RESET_UNITS", () => {
      const prev = this.unitsUsed;
      this.unitsUsed = 0;
      return { prev };
    }, { cost: 0 });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // UTILITIES
  // ──────────────────────────────────────────────────────────────────────────

  _uid() {
    return `${this.clock}-${(this.random() * 0xFFFFFF | 0).toString(16)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ELECTRON MAIN PROCESS BRIDGE
// Creates IPC handlers that proxy through kernel.dispatch()
// ─────────────────────────────────────────────────────────────────────────────

function createIpcBridge(kernel, ipcMain, mainWindow) {

  // Mutation helper — routes through dispatch gate
  const mut = (channel, eventType, transform = (x => x)) => {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        return kernel.dispatch({ type: eventType, payload: transform(payload), origin: "ipc" });
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
  };

  // Read helper — queries never touch the dispatch gate (no cost, no record)
  const qry = (channel, queryType, argFn = (() => [])) => {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        return { ok: true, result: kernel.query(queryType, ...argFn(payload)) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
  };

  // ── Peer Reputation ──────────────────────────────────────────────────────
  qry("rep:getAll", "PEER_REP_ALL");
  qry("rep:get",    "PEER_REP", (peerId) => [peerId]);
  mut("rep:event",  "PEER_REP_EVENT");
  mut("rep:ban",    "PEER_BAN");

  // ── Bandwidth ────────────────────────────────────────────────────────────
  qry("bw:getLimits",  "BW_LIMITS");
  mut("bw:setLimits",  "BW_SET_LIMITS");

  // ── Generic kernel API ────────────────────────────────────────────────────
  ipcMain.handle("kernel:dispatch", async (_event, event) => {
    try {
      return kernel.dispatch({ ...event, origin: "renderer" });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("kernel:query", async (_event, { type, args = [] }) => {
    try {
      return { ok: true, result: kernel.query(type, ...args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("kernel:snapshot", async () => {
    try {
      return { ok: true, result: kernel.snapshot() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Effects that push to renderer ────────────────────────────────────────
  kernel.effect("PEER_REP_EVENT", (result) => {
    if (result.freshBan) {
      mainWindow?.webContents?.send("peer:banned", { peerId: result.peerId, score: result.score });
    }
  });

  kernel.effect("BW_SET_LIMITS", (result) => {
    mainWindow?.webContents?.send("bw:limitsChanged", result);
  });

  // ── Periodic decay (replaces raw setInterval mutating state) ─────────────
  const DECAY_INTERVAL = 60_000;
  setInterval(() => {
    kernel.dispatch({ type: "PEER_REP_DECAY", payload: {}, origin: "scheduler" });
    kernel.dispatch({ type: "KERNEL_RESET_UNITS", payload: {}, origin: "scheduler" }); // prevent unit exhaustion
  }, DECAY_INTERVAL);

  return kernel;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { DispatchKernel, SigPipeline, KernelError, createIpcBridge };
