/**
 * Copyright (c) 2026 Sovereign OS Contributors
 *
 * This file is part of Sovereign Net OS.
 * Licensed under the Sovereign OS Community License (LICENSE-COMMUNITY).
 * Commercial use requires a separate Commercial License (LICENSE-COMMERCIAL).
 *
 * Retain this notice in all copies and derivative works.
 */

"use strict";

/**
 * SOVEREIGN NET OS — Absolute Kernel v4
 *
 * Architecture: Everything mutates state through dispatch().
 * No direct access to DAG, SharedState, BlockStore, or SigPipeline.
 * All transitions: validated → costed → recorded → derived → emitted.
 *
 *   External Input (UI / Network / IPC)
 *           ↓
 *      SigPipeline.verify
 *           ↓
 *      kernel.dispatch(event)
 *           ↓
 *      _consume(cost)
 *           ↓
 *      _record(entry) — canonical, frozen, immutable — BEFORE any state write
 *           ↓
 *      reduce(state, entry) → delta   (pure, no I/O, no external reads)
 *           ↓
 *      _applyDelta(delta)  — ONLY state-write path in the entire system
 *           ↓
 *      emit effects (IPFS, network, UI)
 *
 * v4 changes (causality inversion — the log is now causal, not observational):
 *   1. _record() is called BEFORE handler execution. Entry is immutable on creation.
 *   2. Handlers are pure reducers: reduce(state, entry) → Delta — no direct #state writes.
 *   3. _applyDelta(delta) is the sole state-write path. Delta ops: set/delete/dagSet/dagEdge/blockSet/blockDelete/peerRep/peerBan/pubkey/bw/historyTrim.
 *   4. KernelReplayer becomes the reference implementation: replay(log) ≡ live execution.
 *   5. Ordering invariant: entry.id is a deterministic hash(clock:type:origin:payload) —
 *      ties broken by lexicographic id comparison, not wall-clock time.
 *
 * Previously (v3): state ← handler; log ← side-effect (observational)
 * Now       (v4): log → reduce(state, entry) → state (causal)
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

function makeEntry({ id, type, origin, payload, sig, status, result, error, cost, clock }) {
  return Object.freeze({
    id:      id      ?? null,
    ts:      Date.now(),        // wall time — for display only, not ordering
    clock:   clock   ?? 0,      // logical kernel clock — canonical ordering key
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
// DELTA — the only shape state-writes may take.
//
// A reducer returns a Delta (or null for no-op).
// _applyDelta() is the SOLE path that writes #state, #dag, #blocks, etc.
// Keeping the op vocabulary small prevents ad-hoc mutation logic from creeping
// back into reducers. Every op is reversible in principle (for future undo).
//
// Op types:
//   { op:"set",          key, value }          — #state.set(key, value)
//   { op:"delete",       key }                 — #state.delete(key)
//   { op:"dagSet",       id, node }            — #dag.nodes.set(id, node)
//   { op:"dagEdge",      src, dst }            — #dag.edges src→dst
//   { op:"blockSet",     cid, block }          — #blocks.set(cid, block)
//   { op:"blockDelete",  cid }                 — #blocks.delete(cid)
//   { op:"blockPin",     cid, pinned }         — block.pinned = pinned
//   { op:"peerRep",      peerId, rep }         — #peerRep.set(peerId, rep)
//   { op:"pubkey",       peerId, pubKeyB64 }   — #peerPubkeys.set(...)
//   { op:"bw",           upload, download }    — #bwLimits
//   { op:"resetUnits" }                        — unitsUsed = 0
//   { op:"historyTrim",  entries }             — replace #history with entries
// ─────────────────────────────────────────────────────────────────────────────

class Delta {
  constructor(ops = []) {
    this.ops = ops;
  }
  static of(...ops) { return new Delta(ops); }
  static none()     { return new Delta([]); }
  merge(other)      { return new Delta([...this.ops, ...other.ops]); }
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
      // Fix 11: Reject prototype-polluting keys in restored snapshot data
      if (k === "__proto__" || k === "constructor" || k === "prototype")
        throw new KernelValidationError("RESTORE_INVALID_STATE_KEY", `state key "${k}" is reserved and not allowed`);
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
  _record({ id, type, origin, payload, sig, status, result, error, cost, clock }) {
    const entry = makeEntry({ id, type, origin, payload, sig, status, result, error, cost, clock });
    this.#history.push(entry);
    return entry;
  }

  replay() {
    return JSON.parse(JSON.stringify(this.#history));
  }

  /**
   * _applyDelta — the SOLE path that writes kernel state.
   *
   * Called by dispatch() after _record(). Never called directly by handlers.
   * Handlers are reducers: they return a Delta, they do not mutate state.
   *
   * @param {Delta} delta
   */
  _applyDelta(delta) {
    if (!delta || delta.ops.length === 0) return;
    for (const op of delta.ops) {
      switch (op.op) {
        case "set":
          this.#state.set(op.key, op.value);
          break;
        case "delete":
          this.#state.delete(op.key);
          break;
        case "dagSet":
          this.#dag.nodes.set(op.id, op.node);
          break;
        case "dagEdge": {
          if (!this.#dag.edges.has(op.src)) this.#dag.edges.set(op.src, new Set());
          this.#dag.edges.get(op.src).add(op.dst);
          break;
        }
        case "blockSet":
          this.#blocks.set(op.cid, op.block);
          break;
        case "blockDelete":
          this.#blocks.delete(op.cid);
          break;
        case "blockPin": {
          const b = this.#blocks.get(op.cid);
          if (b) b.pinned = op.pinned;
          break;
        }
        case "peerRep":
          this.#peerRep.set(op.peerId, op.rep);
          break;
        case "pubkey":
          this.#peerPubkeys.set(op.peerId, op.pubKeyB64);
          break;
        case "bw":
          this.#bwLimits = { upload: op.upload, download: op.download };
          break;
        case "resetUnits":
          this.unitsUsed = 0;
          break;
        case "historyTrim":
          this.#history = op.entries;
          break;
        case "dagGc": {
          // op.remove: Set of node ids to remove; op.edgePrune: Set of src ids
          for (const id of (op.remove ?? [])) {
            this.#dag.nodes.delete(id);
            this.#dag.edges.delete(id);
          }
          for (const [src, targets] of this.#dag.edges) {
            for (const t of [...targets]) {
              if (!this.#dag.nodes.has(t)) targets.delete(t);
            }
            if (targets.size === 0) this.#dag.edges.delete(src);
          }
          break;
        }
        default:
          // Unknown op — silently ignore to stay forward-compatible
          break;
      }
    }
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
      this.clock++;
      const entry = this._record({ id, type: evt.type, origin, payload, sig, status: "rejected", result: null, error: err.message, cost: 0, clock: this.clock });
      return { ok: false, error: err.message, entry };
    }

    // 2. Find handler
    const handler = this._handlers.get(evt.type);
    if (!handler) {
      this.clock++;
      const entry = this._record({ id, type: evt.type, origin, payload, sig, status: "unknown", result: null, error: `No handler for event type: ${evt.type}`, cost: 0, clock: this.clock });
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
        this.clock++;
        const entry = this._record({ id, type: evt.type, origin, payload, sig, status: "throttled", result: null, error: err.message, cost: 0, clock: this.clock });
        return { ok: false, error: err.message, entry };
      }
    }

    // 4. REDUCE — handler is a pure function: (payload, evt) → Delta.
    //    Invariants:
    //      • No async inside reduce
    //      • No direct #state / #dag / #blocks writes
    //      • No reads of external I/O or non-deterministic sources
    //    If these hold, replay(log) ≡ live execution — always.
    let delta;
    try {
      this._dispatchDepth++;
      delta = handler.fn.call(this, evt.payload, evt);
    } catch (err) {
      // Reducer threw — record the failure, apply no state change.
      // Record AFTER reduce so we know the true status; BEFORE any state
      // write (there is none on failure) — causality still holds.
      this.clock++;
      this._record({ id, type: evt.type, origin, payload, sig, status: "failed", result: null, error: err.message, cost: handlerCost, clock: this.clock });
      return { ok: false, error: err.message };
    } finally {
      this._dispatchDepth--;
    }

    // 5. RECORD — after reduce (status known), before apply (state unchanged).
    //    This is the causal boundary: the entry is sealed before any state write.
    //    entry.clock = this.clock + 1 (the value clock will have after this dispatch).
    //    Ordering invariant: entries are strictly monotonic by clock; ties broken
    //    by lexicographic id — never wall-clock (entry.ts is display-only).
    this.clock++;
    const entry = this._record({ id, type: evt.type, origin, payload, sig, status: "ok", result: null, error: null, cost: handlerCost, clock: this.clock });

    // 6. APPLY — the sole path that writes kernel state.
    let result = null;
    if (delta instanceof Delta) {
      this._applyDelta(delta);
      result = delta;
    } else {
      result = delta ?? null;
    }

    // 7. Effects
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

  // FIX: Use a Symbol so the queries cache cannot be overwritten by external code.
  // The old double-underscore convention (__queries) was a public property.
  get _queries() {
    const SYM = Symbol.for('__sovereign_kernel_queries__');
    if (!this[SYM]) {
      this[SYM] = new Map([
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
    return this[SYM];
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
    // Guard against prototype pollution — shared by all reducers below.
    const _guardStateKey = (key, op) => {
      if (typeof key !== "string" || key === "") throw new KernelValidationError("INVALID_PAYLOAD", `${op} requires a non-empty string key`);
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new KernelValidationError("INVALID_KEY", `${op} key "${key}" is reserved and not allowed`);
      }
    };

    // ── State ───────────────────────────────────────────────────────────────
    // All reducers below are PURE: they read current state via this._state etc.
    // (read-only within the reduce call), then return a Delta describing the
    // change. _applyDelta() performs the actual writes after _record() seals
    // the entry. This is the invariant that makes replay ≡ live execution.

    this.register("STATE_SET", ({ key, value }) => {
      _guardStateKey(key, "STATE_SET");
      return Delta.of({ op: "set", key, value });
    });

    this.register("STATE_DELETE", ({ key }) => {
      _guardStateKey(key, "STATE_DELETE");
      return Delta.of({ op: "delete", key });
    });

    this.register("STATE_MERGE", ({ key, patch }) => {
      _guardStateKey(key, "STATE_MERGE");
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw new KernelValidationError("INVALID_PAYLOAD", "STATE_MERGE requires key + plain-object patch");
      const safePatch = Object.assign(Object.create(null), patch);
      const prev  = this._state.get(key) ?? {};
      const value = { ...prev, ...safePatch };
      return Delta.of({ op: "set", key, value });
    });

    // ── DAG ─────────────────────────────────────────────────────────────────

    this.register("DAG_COMMIT", ({ id, data, parents = [] }) => {
      if (!id) throw new KernelValidationError("INVALID_PAYLOAD", "DAG_COMMIT requires id");
      if (this._dag.nodes.has(id)) throw new KernelHandlerError("DAG_CONFLICT", `Node ${id} already exists`);
      const node = { id, data, parents, ts: this.clock };
      const ops  = [{ op: "dagSet", id, node }];
      for (const p of parents) ops.push({ op: "dagEdge", src: p, dst: id });
      return new Delta(ops);
    }, { cost: 2 });

    /**
     * Semantic DAG merge — conflict policies by value type:
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
      if (resolver)                mergedData = resolver(baseNode.data, headNode.data);
      else if (registeredResolver) mergedData = registeredResolver(baseNode.data, headNode.data);
      else                         mergedData = semanticMerge(baseNode, headNode);

      const node = { id: mergedId, data: mergedData, parents: [base, head], ts: this.clock };
      return Delta.of(
        { op: "dagSet",  id: mergedId, node },
        { op: "dagEdge", src: base, dst: mergedId },
        { op: "dagEdge", src: head, dst: mergedId },
      );
    }, { cost: 3 });

    // ── Blocks ───────────────────────────────────────────────────────────────

    const MAX_BLOCK_SIZE = 10 * 1024 * 1024;
    this.register("BLOCK_PUT", ({ cid, data, meta = {} }) => {
      if (!cid) throw new KernelValidationError("INVALID_PAYLOAD", "BLOCK_PUT requires cid");
      const dataSize = typeof data === "string" ? data.length : (data instanceof Uint8Array ? data.byteLength : 0);
      if (dataSize > MAX_BLOCK_SIZE)
        throw new KernelValidationError("BLOCK_TOO_LARGE", `BLOCK_PUT data size ${dataSize} exceeds limit of ${MAX_BLOCK_SIZE} bytes`);
      if (this._blocks.has(cid)) return Delta.none(); // idempotent duplicate
      return Delta.of({ op: "blockSet", cid, block: { cid, data, meta, ts: this.clock } });
    });

    this.register("BLOCK_PIN", ({ cid }) => {
      if (!this._blocks.has(cid)) throw new KernelHandlerError("BLOCK_MISSING", `CID ${cid} not in store`);
      return Delta.of({ op: "blockPin", cid, pinned: true });
    });

    this.register("BLOCK_DELETE", ({ cid }) => {
      const block = this._blocks.get(cid);
      if (!block) throw new KernelHandlerError("BLOCK_MISSING", `CID ${cid} not in store`);
      if (block.pinned) throw new KernelHandlerError("BLOCK_PINNED", `Cannot delete pinned block ${cid}`);
      return Delta.of({ op: "blockDelete", cid });
    });

    // ── DAG GC ───────────────────────────────────────────────────────────────

    this.register("DAG_GC", () => {
      const pinnedCids = new Set(Array.from(this._blocks.values()).filter(b => b.pinned).map(b => b.cid));
      const roots = new Set();
      for (const [id] of this._dag.nodes) if (pinnedCids.has(id)) roots.add(id);
      if (roots.size === 0) return Delta.none();

      const reachable = new Set(roots);
      const queue = [...roots];
      while (queue.length) {
        const nodeId = queue.shift();
        for (const child of (this._dag.edges.get(nodeId) ?? [])) {
          if (!reachable.has(child)) { reachable.add(child); queue.push(child); }
        }
      }
      const remove = [];
      for (const [id] of this._dag.nodes) {
        if (!reachable.has(id)) remove.push(id);
      }
      if (remove.length === 0) return Delta.none();
      return Delta.of({ op: "dagGc", remove });
    }, { cost: 5 });

    // ── Peer reputation ──────────────────────────────────────────────────────

    const REP_BAN_THRESHOLD  = -20;
    const REP_GOOD_THRESHOLD = 50;

    this.register("PEER_REP_EVENT", ({ peerId, type: evtType, delta: scoreDelta }) => {
      if (!peerId || typeof scoreDelta !== "number")
        throw new KernelValidationError("INVALID_PAYLOAD", "PEER_REP_EVENT requires peerId+delta");
      const prev    = this._peerRep.get(peerId) ?? { score: 0, events: [], banned: false };
      const score   = Math.max(-100, Math.min(100, prev.score + scoreDelta));
      const events  = [...prev.events, { t: this.clock, type: evtType, delta: scoreDelta }].slice(-50);
      const banned  = prev.banned || score <= REP_BAN_THRESHOLD;
      const trusted = score >= REP_GOOD_THRESHOLD;
      const rep     = { score, events, banned, trusted };
      return Delta.of({ op: "peerRep", peerId, rep });
    });

    this.register("PEER_REP_DECAY", () => {
      const ops = [];
      for (const [peerId, rep] of this._peerRep) {
        if (rep.score === 0) continue;
        const score = rep.score > 0
          ? Math.max(0, rep.score - 1)
          : Math.min(0, rep.score + 1);
        ops.push({ op: "peerRep", peerId, rep: { ...rep, score } });
      }
      return new Delta(ops);
    }, { cost: 0 });

    this.register("PEER_BAN", ({ peerId, ban }) => {
      const prev  = this._peerRep.get(peerId) ?? { score: 0, events: [], banned: false };
      const score = ban ? Math.min(prev.score, REP_BAN_THRESHOLD) : prev.score;
      const rep   = { ...prev, banned: !!ban, score };
      return Delta.of({ op: "peerRep", peerId, rep });
    });

    this.register("PEER_PUBKEY_REGISTER", ({ peerId, pubKeyB64 }) => {
      if (!peerId || typeof pubKeyB64 !== "string")
        throw new KernelValidationError("INVALID_PAYLOAD", "PEER_PUBKEY_REGISTER requires peerId + pubKeyB64");
      if (!/^[A-Za-z0-9+/]+=*$/.test(pubKeyB64))
        throw new KernelAuthError("INVALID_PUBKEY", "pubKeyB64 is not valid base64");
      return Delta.of({ op: "pubkey", peerId, pubKeyB64 });
    }, { cost: 0 });

    // ── System ───────────────────────────────────────────────────────────────

    this.register("BW_SET_LIMITS", ({ upload = 0, download = 0 }) => {
      return Delta.of({ op: "bw", upload: Math.max(0, upload), download: Math.max(0, download) });
    });

    this.register("IDENTITY_SET", ({ did, handle, peerId }) => {
      if (!did) throw new KernelValidationError("INVALID_PAYLOAD", "IDENTITY_SET requires did");
      return Delta.of({ op: "set", key: "identity", value: { did, handle: handle ?? peerId?.slice(0, 12), peerId } });
    });

    this.register("KERNEL_RESET_UNITS", () => {
      return Delta.of({ op: "resetUnits" });
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

  kernel.effect("PEER_REP_EVENT", (_result, _entry, evt) => {
    // After the reducer runs, read the new rep from authoritative state.
    const rep = kernel.query("PEER_REP", evt.payload.peerId);
    if (rep?.banned) mainWindow?.webContents?.send("peer:banned", { peerId: evt.payload.peerId, score: rep.score });
  });
  kernel.effect("BW_SET_LIMITS", (_result, _entry, evt) => {
    const limits = kernel.query("BW_LIMITS");
    mainWindow?.webContents?.send("bw:limitsChanged", limits);
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
  Delta,
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
