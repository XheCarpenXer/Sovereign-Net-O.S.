/**
 * Copyright (c) 2026 Sovereign OS Contributors
 *
 * This file is part of Sovereign Net OS.
 * Licensed under the Sovereign OS Community License (LICENSE-COMMUNITY).
 * Commercial use requires a separate Commercial License (LICENSE-COMMERCIAL).
 *
 * Retain this notice in all copies and derivative works.
 */

/*!
 * enos-storage.js — Sovereign Net OS Unified Storage API
 * Spec: Integration Specification Sheet 1, Item 13
 *
 * Drop this file in src/ and add one line to setup.sh (see below).
 * The foundation (index.html) is never modified.
 *
 * TWO databases, zero conflicts:
 *
 *   'ENOS' (v1)          — all new module data, single 'capsules' object store,
 *                          keys are prefix:id strings (e.g. 'covenant:abc123')
 *
 *   'sovereign-net' (v3) — second read/write connection to the foundation's
 *                          existing stores (dag, identity, channels, files, etc.)
 *                          Multiple connections at the SAME version never block.
 *
 * Usage:
 *   // New namespaced data
 *   await ENOSStorage.covenants.put('cov-1', { text: '...', hash: '...' })
 *   await ENOSStorage.covenants.get('cov-1')      // → { id: 'covenant:cov-1', text, hash }
 *   await ENOSStorage.covenants.list()             // → [...]
 *   await ENOSStorage.covenants.delete('cov-1')
 *
 *   // Legacy foundation stores (read/write)
 *   await ENOSStorage.dag.get('Qm...')
 *   await ENOSStorage.files.list()
 *
 * setup.sh injection line (add after the ipfsAdapter line):
 *   sed -i '' 's|</body>|<script src="src/enos-storage.js"></script>\n</body>|' index.html
 */

(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────────────────
  // ENOS database — new data lives here
  // Single 'capsules' object store; all records keyed by "prefix:id" strings.
  // ──────────────────────────────────────────────────────────────────────────

  const ENOS_DB_NAME    = 'ENOS';
  const ENOS_DB_VERSION = 1;
  const ENOS_STORE      = 'capsules';

  let   _enosDB  = null;
  const _enosQ   = [];   // deferred ops before DB opens

  function _openENOS () {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(ENOS_DB_NAME, ENOS_DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(ENOS_STORE)) {
          db.createObjectStore(ENOS_STORE, { keyPath: 'id' });
        }
      };

      req.onsuccess = (e) => {
        _enosDB = e.target.result;
        while (_enosQ.length) _enosQ.shift()();
        resolve(_enosDB);
      };

      req.onerror   = () => reject(req.error);
      req.onblocked = () => console.warn('[ENOSStorage] ENOS DB upgrade blocked — close other tabs');
    });
  }

  // Defers fn until ENOS DB is open; resolves immediately if already open.
  function _enosReady (fn) {
    if (_enosDB) return Promise.resolve().then(fn);
    return new Promise((res, rej) =>
      _enosQ.push(() => Promise.resolve().then(fn).then(res, rej)));
  }

  // ── Core ops ──────────────────────────────────────────────────────────────

  function _put (id, data) {
    return _enosReady(() => new Promise((res, rej) => {
      // Merge data + id so the keyPath 'id' is always present in the record.
      const r = _enosDB
        .transaction(ENOS_STORE, 'readwrite')
        .objectStore(ENOS_STORE)
        .put(Object.assign({}, data, { id }));
      r.onsuccess = () => res();
      r.onerror   = () => rej(r.error);
    }));
  }

  function _get (id) {
    return _enosReady(() => new Promise((res, rej) => {
      const r = _enosDB
        .transaction(ENOS_STORE, 'readonly')
        .objectStore(ENOS_STORE)
        .get(id);
      r.onsuccess = () => res(r.result ?? null);
      r.onerror   = () => rej(r.error);
    }));
  }

  function _del (id) {
    return _enosReady(() => new Promise((res, rej) => {
      const r = _enosDB
        .transaction(ENOS_STORE, 'readwrite')
        .objectStore(ENOS_STORE)
        .delete(id);
      r.onsuccess = () => res();
      r.onerror   = () => rej(r.error);
    }));
  }

  function _list (prefix) {
    return _enosReady(() => new Promise((res, rej) => {
      const r = _enosDB
        .transaction(ENOS_STORE, 'readonly')
        .objectStore(ENOS_STORE)
        .getAll();
      r.onsuccess = () => {
        const all = r.result ?? [];
        res(prefix ? all.filter(rec => rec.id.startsWith(prefix)) : all);
      };
      r.onerror = () => rej(r.error);
    }));
  }

  async function _clear (prefix) {
    if (!prefix) {
      return _enosReady(() => new Promise((res, rej) => {
        const r = _enosDB
          .transaction(ENOS_STORE, 'readwrite')
          .objectStore(ENOS_STORE)
          .clear();
        r.onsuccess = () => res();
        r.onerror   = () => rej(r.error);
      }));
    }
    // Prefix-scoped clear: list then delete each match
    const records = await _list(prefix);
    await Promise.all(records.map(rec => _del(rec.id)));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Legacy database — second connection to 'sovereign-net'
  // Opens at version 3 (same as foundation). IDB allows N simultaneous
  // connections at the same version with zero contention.
  // ──────────────────────────────────────────────────────────────────────────

  const LEGACY_DB_NAME    = 'sovereign-net';
  const LEGACY_DB_VERSION = 3;

  let   _legacyDB = null;
  const _legacyQ  = [];

  function _openLegacy () {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(LEGACY_DB_NAME, LEGACY_DB_VERSION);

      // This should NOT fire — we're opening at the same version the foundation
      // already created. Guard in case something is misconfigured.
      req.onupgradeneeded = (e) => {
        console.error('[ENOSStorage] Unexpected upgrade on sovereign-net — aborting');
        e.target.transaction.abort();
        reject(new Error('Unexpected legacy DB upgrade'));
      };

      req.onsuccess = (e) => {
        _legacyDB = e.target.result;
        while (_legacyQ.length) _legacyQ.shift()();
        resolve(_legacyDB);
      };

      req.onerror = () => reject(req.error);
    });
  }

  function _legacyReady (fn) {
    if (_legacyDB) return Promise.resolve().then(fn);
    return new Promise((res, rej) =>
      _legacyQ.push(() => Promise.resolve().then(fn).then(res, rej)));
  }

  // Legacy store wrapper — routes get/put/delete/list to an existing store.
  // hasKeyPath: true  → store uses keyPath (channels, files, messages)
  //             false → store uses explicit key (identity, dag, blocks)
  function _legacyNS (storeName, hasKeyPath) {
    const _tx = (mode) => _legacyDB.transaction(storeName, mode).objectStore(storeName);
    return {
      get: (key) =>
        _legacyReady(() => new Promise((res, rej) => {
          const r = _tx('readonly').get(key);
          r.onsuccess = () => res(r.result ?? null);
          r.onerror   = () => rej(r.error);
        })),

      put: (val, key) =>
        _legacyReady(() => new Promise((res, rej) => {
          const r = hasKeyPath
            ? _tx('readwrite').put(val)          // key comes from the object's keyPath
            : _tx('readwrite').put(val, key);    // explicit out-of-line key
          r.onsuccess = () => res();
          r.onerror   = () => rej(r.error);
        })),

      delete: (key) =>
        _legacyReady(() => new Promise((res, rej) => {
          const r = _tx('readwrite').delete(key);
          r.onsuccess = () => res();
          r.onerror   = () => rej(r.error);
        })),

      // indexName + indexVal optional — omit for full store scan
      list: (indexName, indexVal) =>
        _legacyReady(() => new Promise((res, rej) => {
          const store = _tx('readonly');
          const r = indexName
            ? store.index(indexName).getAll(indexVal)
            : store.getAll();
          r.onsuccess = () => res(r.result ?? []);
          r.onerror   = () => rej(r.error);
        })),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Namespace factory — new modules use these, not the raw ops above
  //
  // Each namespace wraps _put/_get/_del/_list/_clear with a fixed key prefix.
  // Keys stored in IDB:  "prefix:userProvidedId"
  // Keys returned to callers: the full record (includes the id field).
  // ──────────────────────────────────────────────────────────────────────────

  function _ns (prefix) {
    return {
      put:    (id, data) => _put(`${prefix}${id}`, data),
      get:    (id)       => _get(`${prefix}${id}`),
      delete: (id)       => _del(`${prefix}${id}`),
      list:   ()         => _list(prefix),
      clear:  ()         => _clear(prefix),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Init
  // ──────────────────────────────────────────────────────────────────────────

  async function _init () {
    try {
      await Promise.all([_openENOS(), _openLegacy()]);
      // Notify the EventBus if it's available (it always will be post-DOMContentLoaded)
      if (window.EventBus) {
        window.EventBus.emit('SYS', { msg: 'ENOSStorage ready — ENOS + sovereign-net' });
      }
    } catch (err) {
      console.error('[ENOSStorage] Init failed:', err);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public API — window.ENOSStorage
  // ──────────────────────────────────────────────────────────────────────────

  window.ENOSStorage = {

    // ── Raw ops (ENOS DB, unnamespaced — prefer namespace accessors below) ──
    put:    _put,
    get:    _get,
    delete: _del,
    list:   _list,
    clear:  _clear,

    // ── Legacy wrappers → 'sovereign-net' existing stores ───────────────────
    dag:      _legacyNS('dag',      false),   // out-of-line key (the CID string)
    identity: _legacyNS('identity', false),   // out-of-line key (e.g. 'keypair')
    channels: _legacyNS('channels', true),    // keyPath: 'id'
    files:    _legacyNS('files',    true),    // keyPath: 'id'
    messages: _legacyNS('messages', true),    // keyPath: 'id', index: 'channel'
    blocks:   _legacyNS('blocks',   false),   // out-of-line key (CID)

    // ── New namespaces → 'ENOS' capsules store ──────────────────────────────
    // Spec sheet 1, item 13 — one entry per planned subsystem
    covenants: _ns('covenant:'),   // spec 1-12  Covenant System
    capsules:  _ns('capsule:'),    // spec 1-2   Sovereign Capsule Export
    neural:    _ns('neural:'),     // spec 1-9   NeuralNetwork weights
    pipelines: _ns('pipeline:'),   // spec 1-5   SolaviaRuntime results
    nft:       _ns('nft:'),        // spec 2-1   NFT Data Licensing
    bounties:  _ns('bounty:'),     // spec 2-5   Bounty & Airdrop Tasks
    partners:  _ns('partner:'),    // spec 2-4   TradingStrategyAgent
    audit:     _ns('audit:'),      // spec 2-2   AuditSwarm reports
    votes:     _ns('vote:'),       // spec 2-2   DAO votes
    appaccess: _ns('appaccess:'),  // spec 2-6   AppBound purchase records

    // ── Lifecycle ────────────────────────────────────────────────────────────
    // Exposed so ext-host / tests can await explicit readiness if needed.
    init: _init,
  };

  // Auto-boot: schedule after DOMContentLoaded so IndexedDB is available.
  // (The foundation guards against calling indexedDB.open before DOM ready.)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    // Script was injected after DOMContentLoaded already fired (dev mode, etc.)
    _init();
  }

})();
