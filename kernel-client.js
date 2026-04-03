/**
 * Copyright (c) 2026 Sovereign OS Contributors
 *
 * This file is part of Sovereign Net OS.
 * Licensed under the Sovereign OS Community License (LICENSE-COMMUNITY).
 * Commercial use requires a separate Commercial License (LICENSE-COMMERCIAL).
 *
 * Retain this notice in all copies and derivative works.
 */

/**
 * SOVEREIGN NET OS — Kernel Client (Renderer)
 *
 * Browser-side wrapper around window.kernel (injected by preload.js).
 * Adds: local event cache, reactive subscriptions, batching, typed helpers.
 *
 * Load this before ipfsAdapter.js, after the Electron preload fires.
 *
 * Usage:
 *   const k = KernelClient.get();
 *
 *   // Mutate
 *   await k.dispatch('STATE_SET', { key: 'theme', value: 'dark' });
 *   await k.dag.commit('node-1', { msg: 'hello' }, []);
 *   await k.peer.report('Qm...', 'spam', -10);
 *
 *   // Read (cached locally)
 *   const theme = await k.query('STATE_GET', 'theme');
 *
 *   // React
 *   k.on('STATE_SET', ({ result }) => console.log('state changed', result));
 *   k.onAny(event => console.log('kernel event', event));
 */

(function (global) {
  'use strict';

  // Only mount if running in Electron with the kernel bridge
  // In plain browser mode, the client stubs all calls gracefully.
  const BRIDGE = global.kernel ?? null;

  // ─────────────────────────────────────────────────────────────────────────
  // Event emitter (tiny)
  // ─────────────────────────────────────────────────────────────────────────

  class EventEmitter {
    constructor() { this._listeners = new Map(); }
    on(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
      return () => this.off(type, fn);
    }
    off(type, fn) {
      const arr = this._listeners.get(type);
      if (arr) this._listeners.set(type, arr.filter(f => f !== fn));
    }
    emit(type, data) {
      (this._listeners.get(type) || []).forEach(fn => { try { fn(data); } catch (_) {} });
      (this._listeners.get('*')  || []).forEach(fn => { try { fn(type, data); } catch (_) {} });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Kernel Client
  // ─────────────────────────────────────────────────────────────────────────

  class KernelClient extends EventEmitter {
    constructor() {
      super();
      this._cache    = new Map();   // query cache: key → { value, ts }
      this._cacheTtl = 2_000;      // ms — how long query results are cached
      this._bridge   = BRIDGE;

      // ── Browser-mode local state (used when no Electron bridge is present) ─
      // Mirrors the subset of kernel state the UI needs: STATE_*, IDENTITY_*,
      // PEER_REP_*, BW_LIMITS. Persisted to the existing IndexedDB store
      // "sovereign-net" (opened by index.html) so state survives page reloads.
      if (!this._bridge) {
        this._local = {
          state:   new Map(),   // key → value  (STATE_*)
          peerRep: new Map(),   // peerId → { score, events, banned }
          bwLimits: { upload: 0, download: 0 },
        };
        this._localDbReady = false;
        this._localDb      = null;
        this._openLocalDb();
      }

      // Listen to kernel events pushed from main process
      if (this._bridge?.onDispatch) {
        this._bridge.onDispatch((event) => {
          // Invalidate cache entries affected by this event
          this._invalidate(event.type);
          this.emit(event.type, event);
          this.emit('*', event);
        });
      }
    }

    // ── IndexedDB bootstrap (browser fallback only) ──────────────────────────
    _openLocalDb() {
      if (typeof indexedDB === 'undefined') return;
      // Reuse the existing "sovereign-net" v3 database opened by index.html.
      // If it isn't open yet we retry once DOMContentLoaded fires.
      const open = () => {
        const req = indexedDB.open('sovereign-net', 3);
        req.onsuccess = (e) => {
          this._localDb      = e.target.result;
          this._localDbReady = true;
          this._hydrateFromDb();
        };
        req.onerror = () => { /* non-fatal — in-memory fallback still works */ };
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', open, { once: true });
      } else {
        open();
      }
    }

    // Read the 'state' object-store into the local Map on startup
    _hydrateFromDb() {
      if (!this._localDb) return;
      try {
        const tx    = this._localDb.transaction('state', 'readonly');
        const store = tx.objectStore('state');
        const req   = store.getAll();
        req.onsuccess = () => {
          // getAll returns values; we need keys too — iterate with openCursor
        };
        // Use cursor to get key+value pairs
        const cursor = store.openCursor();
        cursor.onsuccess = (e) => {
          const c = e.target.result;
          if (!c) return;
          this._local.state.set(c.key, c.value);
          c.continue();
        };
      } catch (_) {}
    }

    // Persist a single state key to IndexedDB
    _persistLocal(storeName, key, value) {
      if (!this._localDb) return;
      try {
        const tx    = this._localDb.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        if (value === undefined || value === null) {
          store.delete(key);
        } else {
          store.put(value, key);
        }
      } catch (_) {}
    }

    // ── Local dispatch (browser fallback) ────────────────────────────────────
    _localDispatch(type, payload) {
      let result = null;
      try {
        switch (type) {
          case 'STATE_SET': {
            const { key, value } = payload;
            if (!key) return { ok: false, error: 'STATE_SET requires key' };
            const prev = this._local.state.get(key);
            this._local.state.set(key, value);
            this._persistLocal('state', key, value);
            result = { key, prev, value };
            break;
          }
          case 'STATE_DELETE': {
            const { key } = payload;
            const prev = this._local.state.get(key);
            this._local.state.delete(key);
            this._persistLocal('state', key, null);
            result = { key, prev };
            break;
          }
          case 'STATE_MERGE': {
            const { key, patch } = payload;
            if (!key || typeof patch !== 'object') return { ok: false, error: 'STATE_MERGE requires key+patch' };
            const prev = this._local.state.get(key) ?? {};
            const next = { ...prev, ...patch };
            this._local.state.set(key, next);
            this._persistLocal('state', key, next);
            result = { key, prev, next };
            break;
          }
          case 'IDENTITY_SET': {
            const { did, handle, peerId } = payload;
            if (!did) return { ok: false, error: 'IDENTITY_SET requires did' };
            const identity = { did, handle: handle ?? peerId?.slice(0, 12), peerId };
            this._local.state.set('identity', identity);
            this._persistLocal('identity', 'identity', identity);
            result = { did, handle: identity.handle };
            break;
          }
          case 'PEER_REP_EVENT': {
            const { peerId, type: evtType, delta } = payload;
            if (!peerId || typeof delta !== 'number') return { ok: false, error: 'PEER_REP_EVENT requires peerId+delta' };
            if (!this._local.peerRep.has(peerId)) {
              this._local.peerRep.set(peerId, { score: 0, events: [], banned: false });
            }
            const rep = this._local.peerRep.get(peerId);
            rep.score = Math.max(-100, Math.min(100, rep.score + delta));
            rep.events.push({ t: Date.now(), type: evtType, delta });
            if (rep.events.length > 50) rep.events.shift();
            if (!rep.banned && rep.score <= -20) rep.banned = true;
            result = { peerId, score: rep.score, banned: rep.banned };
            break;
          }
          case 'PEER_BAN': {
            const { peerId, ban } = payload;
            if (!this._local.peerRep.has(peerId)) {
              this._local.peerRep.set(peerId, { score: 0, events: [], banned: false });
            }
            const rep = this._local.peerRep.get(peerId);
            rep.banned = !!ban;
            result = { peerId, banned: rep.banned };
            break;
          }
          case 'BW_SET_LIMITS': {
            const { upload = 0, download = 0 } = payload;
            this._local.bwLimits.upload   = Math.max(0, upload);
            this._local.bwLimits.download = Math.max(0, download);
            result = { ...this._local.bwLimits };
            break;
          }
          default:
            // Unknown event in browser mode — warn but don't fail hard
            console.warn(`[KernelClient:local] Unhandled local dispatch: ${type}`, payload);
            return { ok: false, error: `No local handler for: ${type}` };
        }
        // Emit so reactive subscribers (k.on / k.onAny) still fire
        this._invalidate(type);
        this.emit(type, { ok: true, result });
        this.emit('*', { type, ok: true, result });
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    // ── Local query (browser fallback) ───────────────────────────────────────
    _localQuery(type, ...args) {
      switch (type) {
        case 'STATE_GET':    return this._local.state.get(args[0]) ?? null;
        case 'STATE_ALL':    return Object.fromEntries(this._local.state);
        case 'PEER_REP':     return this._local.peerRep.get(args[0]) ?? { score: 0, events: [], banned: false };
        case 'PEER_REP_ALL': return Object.fromEntries(this._local.peerRep);
        case 'BW_LIMITS':    return { ...this._local.bwLimits };
        case 'CLOCK':        return 0;  // no clock in browser mode
        default:             return null;
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // CORE API
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Dispatch a typed event through the kernel.
     * All state mutations go through here.
     *
     * @param {string} type
     * @param {object} payload
     * @param {object} [opts]  — { sig, origin }
     * @returns {Promise<{ ok, result, error, entry }>}
     */
    async dispatch(type, payload = {}, opts = {}) {
      if (!this._bridge) return this._localDispatch(type, payload);
      const result = await this._bridge.dispatch({ type, payload, ...opts });
      if (result.ok) {
        this._invalidate(type);
        this.emit(type, result);
        this.emit('*', { type, ...result });
      }
      return result;
    }

    /**
     * Read-only query.
     * Results are cached for cacheTtl ms to avoid hammering IPC.
     *
     * @param {string} type
     * @param {...any} args
     */
    async query(type, ...args) {
      const cacheKey = `${type}:${JSON.stringify(args)}`;
      const cached   = this._cache.get(cacheKey);
      if (cached && (Date.now() - cached.ts) < this._cacheTtl) {
        return cached.value;
      }
      if (!this._bridge) {
        const val = this._localQuery(type, ...args);
        this._cache.set(cacheKey, { value: val, ts: Date.now() });
        return val;
      }
      const res = await this._bridge.query(type, ...args);
      const val = res?.result ?? null;
      this._cache.set(cacheKey, { value: val, ts: Date.now() });
      return val;
    }

    /** Bypass cache — force a fresh read */
    async queryFresh(type, ...args) {
      this._cache.delete(`${type}:${JSON.stringify(args)}`);
      return this.query(type, ...args);
    }

    async snapshot() {
      if (!this._bridge) {
        return {
          state:    Object.fromEntries(this._local.state),
          peerRep:  Object.fromEntries(this._local.peerRep),
          bwLimits: { ...this._local.bwLimits },
          clock:    0,
        };
      }
      const res = await this._bridge.snapshot();
      return res?.result ?? null;
    }

    // ── Subscribe helper — returns unsubscribe fn ────────────────────────────
    onAny(fn) { return this.on('*', fn); }

    // ────────────────────────────────────────────────────────────────────────
    // TYPED HELPERS  (ergonomic wrappers for common operations)
    // ────────────────────────────────────────────────────────────────────────

    get state() {
      return {
        set:    (key, value)  => this.dispatch('STATE_SET',    { key, value }),
        delete: (key)         => this.dispatch('STATE_DELETE', { key }),
        merge:  (key, patch)  => this.dispatch('STATE_MERGE',  { key, patch }),
        get:    (key)         => this.query('STATE_GET', key),
        all:    ()            => this.query('STATE_ALL'),
      };
    }

    get dag() {
      return {
        commit: (id, data, parents = []) =>
          this.dispatch('DAG_COMMIT', { id, data, parents }),
        merge: (base, head) =>
          this.dispatch('DAG_MERGE', { base, head }),
        node:  (id)          => this.query('DAG_NODE', id),
        edges: (id)          => this.query('DAG_EDGES', id),
      };
    }

    get blocks() {
      return {
        put:    (cid, data, meta = {}) => this.dispatch('BLOCK_PUT',    { cid, data, meta }),
        pin:    (cid)                  => this.dispatch('BLOCK_PIN',    { cid }),
        delete: (cid)                  => this.dispatch('BLOCK_DELETE', { cid }),
        get:    (cid)                  => this.query('BLOCK_GET', cid),
      };
    }

    get peer() {
      return {
        report: (peerId, type, delta) =>
          this.dispatch('PEER_REP_EVENT', { peerId, type, delta }),
        ban:    (peerId) => this.dispatch('PEER_BAN', { peerId, ban: true }),
        unban:  (peerId) => this.dispatch('PEER_BAN', { peerId, ban: false }),
        rep:    (peerId) => this.query('PEER_REP', peerId),
        all:    ()       => this.query('PEER_REP_ALL'),
      };
    }

    get bw() {
      return {
        set:    (upload, download) => this.dispatch('BW_SET_LIMITS', { upload, download }),
        limits: ()                 => this.query('BW_LIMITS'),
      };
    }

    get identity() {
      return {
        set: (did, handle, peerId) => this.dispatch('IDENTITY_SET', { did, handle, peerId }),
        get: ()                    => this.query('STATE_GET', 'identity'),
      };
    }

    // ── Replay / time-travel ─────────────────────────────────────────────────

    async replay(toClockT) {
      if (!this._bridge) return null;
      return window.electron?.ipcRenderer?.invoke('kernel:replay', { toClockT }) ?? null;
    }

    async at(clockT) {
      if (!this._bridge) return null;
      return window.electron?.ipcRenderer?.invoke('kernel:at', { clockT }) ?? null;
    }

    async verify(stateKey, expectedValue, atClock) {
      if (!this._bridge) return null;
      return window.electron?.ipcRenderer?.invoke('kernel:verify', { stateKey, expectedValue, atClock }) ?? null;
    }

    // ── Sync ─────────────────────────────────────────────────────────────────

    async syncPull(peerId, sinceClock = 0) {
      if (!this._bridge) return null;
      return window.electron?.ipcRenderer?.invoke('kernel:sync:pull', { peerId, sinceClock }) ?? null;
    }

    /** Deliver a raw pubsub envelope to the sync engine */
    async syncReceive(encoded) {
      if (!this._bridge) return null;
      return window.electron?.ipcRenderer?.invoke('kernel:sync:receive', { encoded }) ?? null;
    }

    async syncStatus() {
      if (!this._bridge) return null;
      return window.electron?.ipcRenderer?.invoke('kernel:sync:status') ?? null;
    }

    // ────────────────────────────────────────────────────────────────────────
    // INTERNALS
    // ────────────────────────────────────────────────────────────────────────

    _invalidate(eventType) {
      // Map event types to query cache keys to invalidate
      const invalidationMap = {
        'STATE_SET':       ['STATE_ALL'],
        'STATE_DELETE':    ['STATE_ALL'],
        'STATE_MERGE':     ['STATE_ALL'],
        'PEER_REP_EVENT':  ['PEER_REP_ALL'],
        'PEER_BAN':        ['PEER_REP_ALL'],
        'BW_SET_LIMITS':   ['BW_LIMITS'],
        'DAG_COMMIT':      [],
        'DAG_MERGE':       [],
        'BLOCK_PUT':       [],
        'IDENTITY_SET':    ['STATE_ALL'],
      };
      const toInvalidate = invalidationMap[eventType] ?? [];
      for (const key of toInvalidate) {
        // Delete all cache entries whose key starts with the query type
        for (const cacheKey of this._cache.keys()) {
          if (cacheKey.startsWith(key)) this._cache.delete(cacheKey);
        }
      }
      // Also invalidate exact-key queries (e.g., STATE_GET:["theme"])
      for (const cacheKey of this._cache.keys()) {
        if (cacheKey.startsWith('STATE_GET') || cacheKey.startsWith('PEER_REP:')) {
          this._cache.delete(cacheKey);
        }
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // SINGLETON
    // ────────────────────────────────────────────────────────────────────────

    static get() {
      if (!KernelClient._instance) {
        KernelClient._instance = new KernelClient();
      }
      return KernelClient._instance;
    }
  }

  KernelClient._instance = null;

  // ── Expose globally ────────────────────────────────────────────────────────
  global.KernelClient = KernelClient;

  // Auto-initialize and expose as window.k for convenience in dev
  global.k = KernelClient.get();

  // ── Wire legacy API surface ────────────────────────────────────────────────
  // Let peerRep and bandwidth still work for existing code, but now they
  // route through the dispatch kernel instead of raw IPC.
  // This means existing calls to window.peerRep.event(...) still work.

  if (global.snos?.isElectron) {
    const client = KernelClient.get();

    global.peerRep = {
      getAll:    ()                    => client.peer.all(),
      get:       (peerId)              => client.peer.rep(peerId),
      event:     (peerId, type, delta) => client.peer.report(peerId, type, delta),
      ban:       (peerId)              => client.peer.ban(peerId),
      unban:     (peerId)              => client.peer.unban(peerId),
      onBanned:  (cb)                  => client.on('PEER_REP_EVENT', ({ result }) => {
        if (result?.freshBan) cb({ peerId: result.peerId, score: result.score });
      }),
    };

    global.bandwidth = {
      getLimits:      ()       => client.bw.limits(),
      setLimits:      (limits) => client.bw.set(limits.upload ?? 0, limits.download ?? 0),
      checkUpload:    (size)   => window.ipfs.api('/stats/bw').then(({ ok, body }) => {
        if (!ok) return { allowed: true };
        return client.bw.limits().then(({ upload }) => {
          if (!upload) return { allowed: true };
          const allowed = (body?.RateOut ?? 0) + (size / 5) <= upload;
          return { allowed, rateOut: body?.RateOut, limit: upload };
        });
      }),
      onLimitsChanged: (cb) => client.on('BW_SET_LIMITS', ({ result }) => cb(result)),
    };
  }

})(window);
