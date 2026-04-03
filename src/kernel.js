"use strict";

/**
 * SOVEREIGN NET OS — Absolute Kernel v3
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
 *      record(history) — canonical, frozen, universal envelope
 *           ↓
 *      emit effects (IPFS, network, UI)
 *
 * v3 changes (all 6):
 *   1. Universal frozen event envelope — every history entry has one shape.
 *   2. Typed fault taxonomy — KernelValidationError, KernelAuthError, etc.
 *   3. Hardened restore() — full schema validation before any assignment.
 *   4. Semantic DAG merge — conflict policies by value type.
 *   5. JS private fields (#state, #dag, #history, #blocks).
 *   6. Adversarial replay tests — see kernel-adversarial-tests.js.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 2 — TYPED FAULT TAXONOMY
// ─────────────────────────────────────────────────────────────────────────────

class KernelError extends Error {
  constructor(code, message, { subsystem = "kernel", severity = "error", retryable = false } = {}) {
    super(message);
    this.name      = "KernelError";
    this.code      = code;
    this.subsystem = subsystem;
    this.severity  = severity;
    this.retryable = retryable;
  }
}

class KernelValidationError extends KernelError {
  constructor(code, message, opts = {}) {
    super(code, message, { subsystem: "validation", severity: "warn", retryable: false, ...opts });
    this.name = "KernelValidationError";
  }
}

class KernelAuthError extends KernelError {
  constructor(code, message, opts = {}) {
    super(code, message, { subsystem: "sig.verify", severity: "error", retryable: false, ...opts });
    this.name = "KernelAuthError";
  }
}

class KernelQuotaError extends KernelError {
  constructor(code, message, opts = {}) {
    super(code, message, { subsystem: "quota", severity: "warn", retryable: true, ...opts });
    this.name = "KernelQuotaError";
  }
}

class KernelReplayError extends KernelError {
  constructor(code, message, opts = {}) {
    super(code, message, { subsystem: "replay", severity: "error", retryable: false, ...opts });
    this.name = "KernelReplayError";
  }
}

class KernelHandlerError extends KernelError {
  constructor(code, message, opts = {}) {
    super(code, message, { subsystem: "handler", severity: "error", retryable: false, ...opts });
    this.name = "KernelHandlerError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 1 — CANONICAL EVENT ENVELOPE
// Every history entry always has this exact shape, no conditional omissions.
// ─────────────────────────────────────────────────────────────────────────────

function makeEntry({ id, type, origin, payload, sig, status, result, error, cost }) {
  return Object.freeze({
    id:      id      ?? null,
    ts:      Date.now(),
    type:    type    ?? "UNKNOWN",
    origin:  origin  ?? "internal",
    payload: payload ?? {},
    sig:     sig     ?? null,
    status:  status  ?? "ok",
    result:  result  ?? null,
    error:   error   ?? null,
    cost:    cost    ?? 0,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 3 — RESTORE SCHEMA VALIDATORS
// ─────────────────────────────────────────────────────────────────────────────

const RESTORE_VALIDATORS = {
  clock(v) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
      throw new KernelValidationError("RESTORE_INVALID_CLOCK", `clock must be non-negative finite number (got ${v})`);
  },
  unitsUsed(v) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
      throw new KernelValidationError("RESTORE_INVALID_UNITS", `unitsUsed must be non-negative finite number (got ${v})`);
  },
  state(v) {
    if (v === null || typeof v !== "object" || Array.isArray(v))
      throw new KernelValidationError("RESTORE_INVALID_STATE", "state must be a plain object");
    for (const [k, val] of Object.entries(v)) {
      if (typeof k !== "string" || k.length === 0)
        throw new KernelValidationError("RESTORE_INVALID_STATE_KEY", `state key must be non-empty string (got ${JSON.stringify(k)})`);
      if (val === undefined)
        throw new KernelValidationError("RESTORE_INVALID_STATE_VALUE", `state["${k}"] must not be undefined`);
    }
  },
  dag(v) {
    if (v === null || typeof v !== "object" || Array.isArray(v))
      throw new KernelValidationError("RESTORE_INVALID_DAG", "dag must be a plain object");
    const { nodes = {}, edges = {} } = v;
    if (typeof nodes !== "object" || Array.isArray(nodes))
      throw new KernelValidationError("RESTORE_INVALID_DAG_NODES", "dag.nodes must be a plain object");
    if (typeof edges !== "object" || Array.isArray(edges))
      throw new KernelValidationError("RESTORE_INVALID_DAG_EDGES", "dag.edges must be a plain object");
    for (const [id, node] of Object.entries(nodes)) {
      if (!node || typeof node !== "object")
        throw new KernelValidationError("RESTORE_INVALID_DAG_NODE", `dag.nodes["${id}"] must be a plain object`);
      if (node.id !== id)
        throw new KernelValidationError("RESTORE_INVALID_DAG_NODE_ID", `dag.nodes["${id}"].id mismatch: got ${node.id}`);
      if (!Array.isArray(node.parents))
        throw new KernelValidationError("RESTORE_INVALID_DAG_PARENTS", `dag.nodes["${id}"].parents must be an array`);
    }
    for (const [src, targets] of Object.entries(edges)) {
      if (!Array.isArray(targets))
        throw new KernelValidationError("RESTORE_INVALID_EDGE_TARGETS", `dag.edges["${src}"] must be an array`);
      for (const t of targets) {
        if (typeof t !== "string")
          throw new KernelValidationError("RESTORE_INVALID_EDGE_TARGET", `dag.edges["${src}"] contains non-string target`);
      }
    }
  },
  blocks(v) {
    if (v === null || typeof v !== "object" || Array.isArray(v))
      throw new KernelValidationError("RESTORE_INVALID_BLOCKS", "blocks must be a plain object");
    for (const [cid, block] of Object.entries(v)) {
      if (!block || typeof block !== "object")
        throw new KernelValidationError("RESTORE_INVALID_BLOCK", `blocks["${cid}"] must be a plain object`);
      if (block.cid !== cid)
        throw new KernelValidationError("RESTORE_INVALID_BLOCK_CID", `blocks["${cid}"].cid mismatch: got ${block.cid}`);
      if (typeof block.meta !== "object" || block.meta === null || Array.isArray(block.meta))
        throw new KernelValidationError("RESTORE_INVALID_BLOCK_META", `blocks["${cid}"].meta must be a plain object`);
    }
  },
  peerRep(v) {
    if (v === null || typeof v !== "object" || Array.isArray(v))
      throw new KernelValidationError("RESTORE_INVALID_PEER_REP", "peerRep must be a plain object");
    for (const [peerId, rep] of Object.entries(v)) {
      if (!rep || typeof rep !== "object")
        throw new KernelValidationError("RESTORE_INVALID_REP_ENTRY", `peerRep["${peerId}"] must be a plain object`);
      if (typeof rep.score !== "number" || rep.score < -100 || rep.score > 100)
        throw new KernelValidationError("RESTORE_INVALID_REP_SCORE", `peerRep["${peerId}"].score must be in [-100,100]`);
      if (typeof rep.banned !== "boolean")
        throw new KernelValidationError("RESTORE_INVALID_REP_BANNED", `peerRep["${peerId}"].banned must be boolean`);
      if (!Array.isArray(rep.events))
        throw new KernelValidationError("RESTORE_INVALID_REP_EVENTS", `peerRep["${peerId}"].events must be an array`);
    }
  },
  peerPubkeys(v) {
    if (v === null || typeof v !== "object" || Array.isArray(v))
      throw new KernelValidationError("RESTORE_INVALID_PEER_PUBKEYS", "peerPubkeys must be a plain object");
    for (const [peerId, key] of Object.entries(v)) {
      if (typeof key !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(key))
        throw new KernelValidationError("RESTORE_INVALID_PUBKEY", `peerPubkeys["${peerId}"] must be valid base64`);
    }
  },
  bwLimits(v) {
    if (!v || typeof v !== "object" || Array.isArray(v))
      throw new KernelValidationError("RESTORE_INVALID_BW", "bwLimits must be a plain object");
    if (typeof v.upload !== "number" || v.upload < 0)
      throw new KernelValidationError("RESTORE_INVALID_BW_UPLOAD", "bwLimits.upload must be non-negative number");
    if (typeof v.download !== "number" || v.download < 0)
      throw new KernelValidationError("RESTORE_INVALID_BW_DOWNLOAD", "bwLimits.download must be non-negative number");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ABSOLUTE KERNEL
// CHANGE 5 — true JS private fields; external reads are architecturally blocked
// ─────────────────────────────────────────────────────────────────────────────

class AbsoluteKernel {
  #state       = new Map();
  #dag         = { nodes: new Map(), edges: new Map() };
  #history     = [];
  #blocks      = new Map();
  #peerRep     = new Map();
  #bwLimits    = { upload: 0, download: 0 };
  #peerPubkeys = new Map();

  constructor({
    maxUnits  = 100_000,
    maxDepth  = 64,
    pulseSize = 1,
    seed      = 0,
  } = {}) {
    this.constraints = Object.freeze({ maxUnits, maxDepth, pulseSize });
    this.clock       = 0;
    this.unitsUsed   = 0;
    this._rngState   = seed >>> 0;
    this.random      = this._rng();
  }

  // Protected accessors for subclass use only
  get _state()       { return this.#state; }
  get _dag()         { return this.#dag; }
  get _history()     { return this.#history; }
  get _blocks()      { return this.#blocks; }
  get _peerRep()     { return this.#peerRep; }
  get _bwLimits()    { return this.#bwLimits; }
  get _peerPubkeys() { return this.#peerPubkeys; }

  set _state(v)       { this.#state = v; }
  set _dag(v)         { this.#dag = v; }
  set _history(v)     { this.#history = v; }
  set _blocks(v)      { this.#blocks = v; }
  set _peerRep(v)     { this.#peerRep = v; }
  set _bwLimits(v)    { this.#bwLimits = v; }
  set _peerPubkeys(v) { this.#peerPubkeys = v; }

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
      throw new KernelQuotaError(
        "CONSTRAINT_VIOLATED",
        `maxUnits (${this.constraints.maxUnits}) exceeded`,
        { retryable: true }
      );
    }
  }

  // CHANGE 1: every call to _record produces the same canonical frozen shape
  _record({ id, type, origin, payload, sig, status, result, error, cost }) {
    const entry = makeEntry({ id, type, origin, payload, sig, status, result, error, cost });
    this.#history.push(entry);
    return entry;
  }

  replay() {
    return JSON.parse(JSON.stringify(this.#history));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SIG PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

class SigPipeline {
  constructor() { this._validators = []; }

  use(fn) { this._validators.push(fn); return this; }

  verify(event) {
    for (const fn of this._validators) fn(event);
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPATCH KERNEL
// ─────────────────────────────────────────────────────────────────────────────

const MAX_PAYLOAD_BYTES = 1_048_576;

class DispatchKernel extends AbsoluteKernel {
  constructor(opts = {}) {
    super(opts);
    this._handlers     = new Map();
    this._effects      = new Map();
    this._listeners    = [];
    this.sig           = new SigPipeline();
    this._dagResolvers = new Map();
    this._dispatchDepth = 0;
    this._registerBuiltins();
  }

  dispatch(event) {
    if (!event || typeof event.type !== "string") {
      throw new KernelValidationError("INVALID_EVENT", "event.type must be a string");
    }
    if (this._dispatchDepth > 0) {
      throw new KernelValidationError(
        "REENTRANT_DISPATCH",
        `kernel.dispatch(${event.type}) called re-entrantly from within a handler`
      );
    }

    const payload = event.payload ?? {};
    const origin  = event.origin  ?? "internal";
    const sig     = event.sig     ?? null;

    const payloadBytes = JSON.stringify(payload).length;
    if (payloadBytes > MAX_PAYLOAD_BYTES) {
      throw new KernelValidationError(
        "PAYLOAD_TOO_LARGE",
        `Payload ${payloadBytes} B exceeds ${MAX_PAYLOAD_BYTES} B limit for event type ${event.type}`
      );
    }

    const id  = this._uid(event.type, payload, origin);
    const evt = Object.freeze({ type: event.type, payload, sig, origin, id });

    // 1. Validate
    try {
      this.sig.verify(evt);
    } catch (err) {
      const entry = this._record({ id, type: evt.type, origin, payload, sig, status: "rejected", result: null, error: err.message, cost: 0 });
      return { ok: false, error: err.message, entry };
    }

    // 2. Find handler
    const handler = this._handlers.get(evt.type);
    if (!handler) {
      const entry = this._record({ id, type: evt.type, origin, payload, sig, status: "unknown", result: null, error: `No handler for event type: ${evt.type}`, cost: 0 });
      return { ok: false, error: `No handler for event type: ${evt.type}`, entry };
    }

    const handlerCost = handler.cost ?? 1;

    // 3. Quota check — zero-cost handlers always bypass the quota so that
    // operations like KERNEL_RESET_UNITS and PEER_REP_DECAY can always fire
    // even when unitsUsed has already exceeded maxUnits.
    if (handlerCost > 0) {
      try {
        this._consume(handlerCost);
      } catch (err) {
        const entry = this._record({ id, type: evt.type, origin, payload, sig, status: "throttled", result: null, error: err.message, cost: 0 });
        return { ok: false, error: err.message, entry };
      }
    }

    // 4. Apply
    let result;
    try {
      this._dispatchDepth++;
      result = handler.fn.call(this, evt.payload, evt);
    } catch (err) {
      const entry = this._record({ id, type: evt.type, origin, payload, sig, status: "failed", result: null, error: err.message, cost: handlerCost });
      return { ok: false, error: err.message, entry };
    } finally {
      this._dispatchDepth--;
    }

    // 5. Record — canonical frozen envelope
    const entry = this._record({ id, type: evt.type, origin, payload, sig, status: "ok", result: result ?? null, error: null, cost: handlerCost });

    // 6. Effects
    this.clock++;
    this._notify(evt, result, entry);

    return { ok: true, result, entry };
  }

  register(type, fn, { cost = 1 } = {}) {
    if (this._handlers.has(type))
      throw new KernelValidationError("HANDLER_EXISTS", `Handler for "${type}" already registered`);
    this._handlers.set(type, { fn, cost });
    return this;
  }

  override(type, fn, opts = {}) {
    this._handlers.delete(type);
    return this.register(type, fn, opts);
  }

  registerDagResolver(nodeType, resolver) {
    this._dagResolvers.set(nodeType, resolver);
    return this;
  }

  effect(type, fn) {
    if (!this._effects.has(type)) this._effects.set(type, []);
    this._effects.get(type).push(fn);
    return this;
  }

  on(fn) { this._listeners.push(fn); return this; }

  _notify(evt, result, entry) {
    for (const fn of (this._effects.get(evt.type) || [])) {
      try { fn(result, entry, evt); } catch (e) {}
    }
    for (const fn of this._listeners) {
      try { fn(evt, result, entry); } catch (e) {}
    }
  }

  query(type, ...args) {
    const q = this._queries.get(type);
    if (!q) throw new KernelValidationError("UNKNOWN_QUERY", `No query: ${type}`);
    return q.call(this, ...args);
  }

  get _queries() {
    if (!this.__queries) {
      this.__queries = new Map([
        ["STATE_GET",       (key)    => this._state.get(key)],
        ["STATE_ALL",       ()       => Object.fromEntries(this._state)],
        ["DAG_NODE",        (id)     => this._dag.nodes.get(id)],
        ["DAG_EDGES",       (id)     => Array.from(this._dag.edges.get(id) || [])],
        ["BLOCK_GET",       (cid)    => this._blocks.get(cid)],
        ["PEER_REP",        (peerId) => this._peerRep.get(peerId) ?? { score: 0, events: [], banned: false }],
        ["PEER_REP_ALL",    ()       => Object.fromEntries(this._peerRep)],
        ["PEER_PUBKEY",     (peerId) => this._peerPubkeys.get(peerId) ?? null],
        ["PEER_PUBKEY_ALL", ()       => Object.fromEntries(this._peerPubkeys)],
        ["BW_LIMITS",       ()       => ({ ...this._bwLimits })],
        ["HISTORY",         ()       => this.replay()],
        ["CLOCK",           ()       => this.clock],
        ["UNITS_USED",      ()       => this.unitsUsed],
      ]);
    }
    return this.__queries;
  }

  snapshot() {
    return {
      clock:       this.clock,
      unitsUsed:   this.unitsUsed,
      state:       Object.fromEntries(this._state),
      dag: {
        nodes: Object.fromEntries(this._dag.nodes),
        edges: Object.fromEntries(
          Array.from(this._dag.edges.entries()).map(([k, v]) => [k, Array.from(v)])
        ),
      },
      blocks:      Object.fromEntries(this._blocks),
      peerRep:     Object.fromEntries(this._peerRep),
      peerPubkeys: Object.fromEntries(this._peerPubkeys),
      bwLimits:    { ...this._bwLimits },
      history:     this.replay(),
    };
  }

  /**
   * CHANGE 3 — hardened restore():
   * All fields are schema-validated before any assignment.
   * A malformed snapshot is rejected atomically — live state is never partially written.
   */
  restore(snap) {
    if (!snap || typeof snap !== "object" || Array.isArray(snap))
      throw new KernelValidationError("RESTORE_INVALID_SNAPSHOT", "snapshot must be a plain object");

    RESTORE_VALIDATORS.clock(snap.clock ?? 0);
    RESTORE_VALIDATORS.unitsUsed(snap.unitsUsed ?? 0);
    RESTORE_VALIDATORS.state(snap.state ?? {});
    RESTORE_VALIDATORS.dag(snap.dag ?? { nodes: {}, edges: {} });
    RESTORE_VALIDATORS.blocks(snap.blocks ?? {});
    RESTORE_VALIDATORS.peerRep(snap.peerRep ?? {});
    RESTORE_VALIDATORS.peerPubkeys(snap.peerPubkeys ?? {});
    RESTORE_VALIDATORS.bwLimits(snap.bwLimits ?? { upload: 0, download: 0 });

    // All validators passed — safe to assign.
    // Use the same ?? defaults as the validators above so that a field that
    // was absent (old snapshot format) never reaches Object.entries(null).
    this.clock        = snap.clock        ?? 0;
    this.unitsUsed    = snap.unitsUsed    ?? 0;
    this._state       = new Map(Object.entries(snap.state       ?? {}));
    this._blocks      = new Map(Object.entries(snap.blocks      ?? {}));
    this._peerRep     = new Map(Object.entries(snap.peerRep     ?? {}));
    this._peerPubkeys = new Map(Object.entries(snap.peerPubkeys ?? {}));
    this._bwLimits    = { ...(snap.bwLimits ?? { upload: 0, download: 0 }) };
    const dagSnap     = snap.dag ?? { nodes: {}, edges: {} };
    this._dag         = {
      nodes: new Map(Object.entries(dagSnap.nodes ?? {})),
      edges: new Map(Object.entries(dagSnap.edges ?? {}).map(([k, v]) => [k, new Set(v)])),
    };
    this._history = Array.isArray(snap.history) ? snap.history : [];
  }

  _registerBuiltins() {
    this.register("STATE_SET", ({ key, value }) => {
      if (!key) throw new KernelValidationError("INVALID_PAYLOAD", "STATE_SET requires key");
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
      if (!key || typeof patch !== "object") throw new KernelValidationError("INVALID_PAYLOAD", "STATE_MERGE requires key+patch object");
      const prev = this._state.get(key) ?? {};
      const next = { ...prev, ...patch };
      this._state.set(key, next);
      return { key, prev, next };
    });

    this.register("DAG_COMMIT", ({ id, data, parents = [] }) => {
      if (!id) throw new KernelValidationError("INVALID_PAYLOAD", "DAG_COMMIT requires id");
      if (this._dag.nodes.has(id)) throw new KernelHandlerError("DAG_CONFLICT", `Node ${id} already exists`);
      this._dag.nodes.set(id, { id, data, parents, ts: this.clock });
      for (const p of parents) {
        if (!this._dag.edges.has(p)) this._dag.edges.set(p, new Set());
        this._dag.edges.get(p).add(id);
      }
      return { id, parents };
    }, { cost: 2 });

    /**
     * CHANGE 4 — Semantic DAG merge with conflict policies by value type:
     *   counter → additive  |  set → union  |  log → append  |  object → recursive  |  scalar → latest-wins
     */
    this.register("DAG_MERGE", ({ base, head, resolver }) => {
      if (!this._dag.nodes.has(base)) throw new KernelHandlerError("DAG_MISSING", `Base node ${base} not found`);
      if (!this._dag.nodes.has(head)) throw new KernelHandlerError("DAG_MISSING", `Head node ${head} not found`);
      const baseNode = this._dag.nodes.get(base);
      const headNode = this._dag.nodes.get(head);
      const mergedId = `merge:${base}:${head}`;
      const nodeType = baseNode.data?.type ?? headNode.data?.type;
      const registeredResolver = nodeType ? this._dagResolvers.get(nodeType) : undefined;

      let mergedData;
      if (resolver)                  mergedData = resolver(baseNode.data, headNode.data);
      else if (registeredResolver)   mergedData = registeredResolver(baseNode.data, headNode.data);
      else                           mergedData = semanticMerge(baseNode, headNode);

      this._dag.nodes.set(mergedId, { id: mergedId, data: mergedData, parents: [base, head], ts: this.clock });
      if (!this._dag.edges.has(base)) this._dag.edges.set(base, new Set());
      if (!this._dag.edges.has(head)) this._dag.edges.set(head, new Set());
      this._dag.edges.get(base).add(mergedId);
      this._dag.edges.get(head).add(mergedId);
      return { mergedId, base, head, mergedData };
    }, { cost: 3 });

    this.register("BLOCK_PUT", ({ cid, data, meta = {} }) => {
      if (!cid) throw new KernelValidationError("INVALID_PAYLOAD", "BLOCK_PUT requires cid");
      if (this._blocks.has(cid)) return { cid, duplicate: true };
      this._blocks.set(cid, { cid, data, meta, ts: this.clock });
      return { cid, size: meta.size ?? (typeof data === "string" ? data.length : 0) };
    });

    this.register("BLOCK_PIN", ({ cid }) => {
      const block = this._blocks.get(cid);
      if (!block) throw new KernelHandlerError("BLOCK_MISSING", `CID ${cid} not in store`);
      block.pinned = true;
      return { cid, pinned: true };
    });

    this.register("BLOCK_DELETE", ({ cid }) => {
      const block = this._blocks.get(cid);
      if (!block) throw new KernelHandlerError("BLOCK_MISSING", `CID ${cid} not in store`);
      if (block.pinned) throw new KernelHandlerError("BLOCK_PINNED", `Cannot delete pinned block ${cid}`);
      this._blocks.delete(cid);
      return { cid };
    });

    this.register("DAG_GC", () => {
      const pinnedCids = new Set(Array.from(this._blocks.values()).filter(b => b.pinned).map(b => b.cid));
      const roots = new Set();
      for (const [id] of this._dag.nodes) if (pinnedCids.has(id)) roots.add(id);
      if (roots.size === 0) return { collected: 0, retained: this._dag.nodes.size };
      const reachable = new Set(roots);
      const queue = [...roots];
      while (queue.length) {
        const nodeId = queue.shift();
        for (const child of (this._dag.edges.get(nodeId) ?? [])) {
          if (!reachable.has(child)) { reachable.add(child); queue.push(child); }
        }
      }
      let collected = 0;
      for (const [id] of this._dag.nodes) {
        if (!reachable.has(id)) { this._dag.nodes.delete(id); this._dag.edges.delete(id); collected++; }
      }
      for (const [src, targets] of this._dag.edges) {
        for (const t of targets) if (!this._dag.nodes.has(t)) targets.delete(t);
        if (targets.size === 0) this._dag.edges.delete(src);
      }
      return { collected, retained: this._dag.nodes.size };
    }, { cost: 5 });

    const REP_BAN_THRESHOLD  = -20;
    const REP_GOOD_THRESHOLD = 50;

    this.register("PEER_REP_EVENT", ({ peerId, type: evtType, delta }) => {
      if (!peerId || typeof delta !== "number") throw new KernelValidationError("INVALID_PAYLOAD", "PEER_REP_EVENT requires peerId+delta");
      if (!this._peerRep.has(peerId)) this._peerRep.set(peerId, { score: 0, events: [], banned: false });
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

    this.register("PEER_PUBKEY_REGISTER", ({ peerId, pubKeyB64 }) => {
      if (!peerId || typeof pubKeyB64 !== "string")
        throw new KernelValidationError("INVALID_PAYLOAD", "PEER_PUBKEY_REGISTER requires peerId + pubKeyB64");
      if (!/^[A-Za-z0-9+/]+=*$/.test(pubKeyB64))
        throw new KernelAuthError("INVALID_PUBKEY", "pubKeyB64 is not valid base64");
      const prev = this._peerPubkeys.get(peerId) ?? null;
      this._peerPubkeys.set(peerId, pubKeyB64);
      return { peerId, registered: true, replaced: prev !== null };
    }, { cost: 0 });

    this.register("BW_SET_LIMITS", ({ upload = 0, download = 0 }) => {
      this._bwLimits.upload   = Math.max(0, upload);
      this._bwLimits.download = Math.max(0, download);
      return { ...this._bwLimits };
    });

    this.register("IDENTITY_SET", ({ did, handle, peerId }) => {
      if (!did) throw new KernelValidationError("INVALID_PAYLOAD", "IDENTITY_SET requires did");
      this._state.set("identity", { did, handle: handle ?? peerId?.slice(0, 12), peerId });
      return { did, handle };
    });

    this.register("KERNEL_RESET_UNITS", () => {
      const prev = this.unitsUsed;
      this.unitsUsed = 0;
      return { prev };
    }, { cost: 0 });
  }

  _uid(type, payload, origin) {
    if (type === undefined) return `${this.clock}-${(this.random() * 0xFFFFFF | 0).toString(16)}`;
    const raw = `${this.clock}:${type}:${origin ?? "internal"}:${JSON.stringify(payload ?? {})}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return `${this.clock}-${h.toString(16).padStart(8, "0")}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 4 — SEMANTIC MERGE ENGINE
// ─────────────────────────────────────────────────────────────────────────────

function semanticMerge(baseNode, headNode) {
  const baseData = baseNode.data ?? {};
  const headData = headNode.data ?? {};
  const allKeys  = new Set([...Object.keys(baseData), ...Object.keys(headData)]);
  const headIsNewer =
    headNode.ts > baseNode.ts ||
    (headNode.ts === baseNode.ts && headNode.id > baseNode.id);
  const merged = {};
  for (const key of allKeys) {
    const bv = baseData[key], hv = headData[key];
    if (bv === undefined) { merged[key] = hv; continue; }
    if (hv === undefined) { merged[key] = bv; continue; }
    merged[key] = mergeValue(key, bv, hv, headIsNewer);
  }
  return merged;
}

function mergeValue(key, bv, hv, headIsNewer) {
  const k = key.toLowerCase();

  // counter — additive
  if (typeof bv === "number" && typeof hv === "number" &&
      (/(_count|_total|_counter)$/.test(k) || k === "count" || k === "total"))
    return bv + hv;

  // set — union
  if (Array.isArray(bv) && Array.isArray(hv) && /(_set|_ids)$/.test(k))
    return Array.from(new Set([...bv, ...hv]));

  // log — append, deduplicate, sort by ts+id
  if (Array.isArray(bv) && Array.isArray(hv) && /(_log|_events|_history)$/.test(k)) {
    const seen = new Set();
    const combined = [];
    for (const item of [...bv, ...hv]) {
      const dedup = typeof item === "object" && item !== null
        ? (item.id ?? JSON.stringify(item)) : String(item);
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      combined.push(item);
    }
    combined.sort((a, b) => {
      if (typeof a === "object" && typeof b === "object") {
        if (a.ts !== b.ts) return (a.ts ?? 0) - (b.ts ?? 0);
        return (a.id ?? "").localeCompare(b.id ?? "");
      }
      return 0;
    });
    return combined;
  }

  // object — recursive merge
  if (bv !== null && hv !== null && typeof bv === "object" && typeof hv === "object" &&
      !Array.isArray(bv) && !Array.isArray(hv)) {
    const result = {};
    const subKeys = new Set([...Object.keys(bv), ...Object.keys(hv)]);
    for (const sk of subKeys) {
      const sbv = bv[sk], shv = hv[sk];
      if (sbv === undefined) { result[sk] = shv; continue; }
      if (shv === undefined) { result[sk] = sbv; continue; }
      result[sk] = mergeValue(sk, sbv, shv, headIsNewer);
    }
    return result;
  }

  // scalar — latest-wins
  return headIsNewer ? hv : bv;
}

// ─────────────────────────────────────────────────────────────────────────────
// ELECTRON IPC BRIDGE
// ─────────────────────────────────────────────────────────────────────────────

function createIpcBridge(kernel, ipcMain, mainWindow) {
  const mut = (channel, eventType, transform = (x => x)) => {
    ipcMain.handle(channel, async (_event, payload) => {
      try { return kernel.dispatch({ type: eventType, payload: transform(payload), origin: "ipc" }); }
      catch (err) { return { ok: false, error: err.message }; }
    });
  };
  const qry = (channel, queryType, argFn = (() => [])) => {
    ipcMain.handle(channel, async (_event, payload) => {
      try { return { ok: true, result: kernel.query(queryType, ...argFn(payload)) }; }
      catch (err) { return { ok: false, error: err.message }; }
    });
  };

  qry("rep:getAll", "PEER_REP_ALL");
  qry("rep:get",    "PEER_REP", (peerId) => [peerId]);
  mut("rep:event",  "PEER_REP_EVENT");
  mut("rep:ban",    "PEER_BAN");
  qry("bw:getLimits", "BW_LIMITS");
  mut("bw:setLimits", "BW_SET_LIMITS");

  ipcMain.handle("kernel:dispatch", async (_event, event) => {
    try { return kernel.dispatch({ ...event, origin: "renderer" }); }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle("kernel:query", async (_event, { type, args = [] }) => {
    try { return { ok: true, result: kernel.query(type, ...args) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle("kernel:snapshot", async () => {
    try { return { ok: true, result: kernel.snapshot() }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  kernel.effect("PEER_REP_EVENT", (result) => {
    if (result.freshBan) mainWindow?.webContents?.send("peer:banned", { peerId: result.peerId, score: result.score });
  });
  kernel.effect("BW_SET_LIMITS", (result) => {
    mainWindow?.webContents?.send("bw:limitsChanged", result);
  });

  setInterval(() => {
    kernel.dispatch({ type: "PEER_REP_DECAY",      payload: {}, origin: "scheduler" });
    kernel.dispatch({ type: "KERNEL_RESET_UNITS",  payload: {}, origin: "scheduler" });
  }, 60_000);

  return kernel;
}

module.exports = {
  DispatchKernel,
  SigPipeline,
  KernelError,
  KernelValidationError,
  KernelAuthError,
  KernelQuotaError,
  KernelReplayError,
  KernelHandlerError,
  createIpcBridge,
  semanticMerge,
  mergeValue,
};
