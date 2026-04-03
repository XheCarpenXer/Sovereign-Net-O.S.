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
 * ext-host.js — Sovereign Net OS Extension Host
 * Spec: Architecture defined in modular extension plan
 *
 * Injected by setup.sh. The foundation (index.html, src/*.js) is never modified.
 *
 * ── Module contract ──────────────────────────────────────────────────────────
 *
 *   window.__ext.register('my-module', function (api) {
 *
 *     // Subscribe to any EventBus event
 *     api.on('PEER_JOIN', ({ msg }) => console.log(msg));
 *
 *     // Subscribe to incoming BroadcastChannel messages
 *     api.meshListen('COVENANT', (data) => handleRemoteCovenant(data));
 *
 *     // Emit an event to the activity feed
 *     api.emit('SYS', { msg: 'my-module online' });
 *
 *     // Read node identity (read-only, no privateKey)
 *     const { did, handle } = api.identity ?? {};
 *
 *     // Persistent storage
 *     await api.storage.covenants.put('cov-1', { text: '...' });
 *
 *     // Crypto
 *     const hash = await api.hash('hello');
 *     const sig  = await api.sign(hash);
 *
 *     // Expose a public API (optional)
 *     return {
 *       doThing () { ... }
 *     };
 *   }, { version: '1.0.0', description: 'Does a thing' });
 *
 *   // Consume from any other module or console:
 *   window.__ext.get('my-module').doThing();
 *
 * ── setup.sh injection lines ─────────────────────────────────────────────────
 *
 *   # Add BOTH lines before </body>, enos-storage first:
 *   sed ... 's|</body>|<script src="src/enos-storage.js"></script>\n</body>|'
 *   sed ... 's|</body>|<script src="src/ext-host.js"></script>\n</body>|'
 *
 *   # Then for each module:
 *   sed ... 's|</body>|<script src="modules/cst.js"></script>\n</body>|'
 */

(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────────────────
  // Internal state
  // ──────────────────────────────────────────────────────────────────────────

  const REGISTRY = new Map();   // name → { meta, mod }
  const QUEUE    = [];          // { name, initFn, meta } registered before DOM ready
  let   _ready   = false;

  // Mesh listener table — type → fn[]
  // Populated via api.meshListen(); drained in _tapMeshBus().
  const _meshListeners = {};

  // ──────────────────────────────────────────────────────────────────────────
  // kernelAPI factory
  // Built fresh for each module boot (after DOM ready) so all OS globals are live.
  // Frozen so modules can't accidentally reassign the API methods.
  // ──────────────────────────────────────────────────────────────────────────

  function _buildAPI () {
    return Object.freeze({

      // ── Events ────────────────────────────────────────────────────────────
      // Subscribe to any EventBus event type.
      // Use type '*' to receive every event.
      on:   (type, fn)      => window.EventBus?.on(type, fn),

      // Emit an event — appears in the Home activity feed + EventBus listeners.
      emit: (type, payload) => window.EventBus?.emit(type, payload),

      // ── State ─────────────────────────────────────────────────────────────
      // Returns a shallow copy of STATE. Modules must NOT mutate STATE directly.
      getState: () => window.STATE ? Object.assign({}, window.STATE) : null,

      // ── Dispatch ──────────────────────────────────────────────────────────
      // Electron:  routes to kernel.dispatch() via the IPC bridge that
      //            ipfsAdapter installed as window.__kernelDispatch.
      // Browser:   falls back to EventBus emit + meshBus broadcast.
      dispatch: (event) => {
        if (typeof window.__kernelDispatch === 'function') {
          return window.__kernelDispatch(event);
        }
        // Browser fallback
        window.EventBus?.emit(event.type, event.payload ?? event);
        if (window.meshBus && window.STATE?.did) {
          window.meshBus.postMessage({
            type:    event.type,
            payload: event.payload ?? event,
            from:    window.STATE.did,
            ts:      Date.now(),
          });
        }
      },

      // ── Storage ───────────────────────────────────────────────────────────
      // Live reference to ENOSStorage.
      // Modules should call api.storage.covenants.put(...)  etc.
      get storage () { return window.ENOSStorage ?? null; },

      // ── Identity (read-only, no privateKey) ───────────────────────────────
      get identity () {
        const s = window.STATE;
        if (!s?.did) return null;
        return Object.freeze({
          did:      s.did,
          handle:   s.handle,
          pubKeyB64: s.pubKeyB64,
        });
      },

      // ── Crypto helpers ────────────────────────────────────────────────────
      // Modules should use these rather than touching SubtleCrypto directly,
      // so they automatically use the same key type the OS uses (ECDSA P-256).

      // SHA-256 → 64-char hex string
      hash: async (str) => {
        const buf = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(str)
        );
        return Array.from(new Uint8Array(buf))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
      },

      // Sign dataStr with the node's private key → base64 signature
      sign: async (dataStr) => {
        if (!window.STATE?.privateKey) throw new Error('[ext-host] No private key — identity not loaded');
        const buf = await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          window.STATE.privateKey,
          new TextEncoder().encode(dataStr)
        );
        return btoa(String.fromCharCode(...new Uint8Array(buf)));
      },

      // Verify a signature produced by sign() above.
      // pubKeyB64: the signer's base64-encoded SPKI public key.
      verify: async (dataStr, sigB64, pubKeyB64) => {
        try {
          const raw = Uint8Array.from(atob(pubKeyB64), c => c.charCodeAt(0));
          const key = await crypto.subtle.importKey(
            'spki', raw.buffer,
            { name: 'ECDSA', namedCurve: 'P-256' },
            true, ['verify']
          );
          const sig = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
          return await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            key, sig.buffer,
            new TextEncoder().encode(dataStr)
          );
        } catch {
          return false;
        }
      },

      // ── Mesh ──────────────────────────────────────────────────────────────

      // Broadcast a typed message to all tabs / Electron peers.
      meshSend: (type, payload) => {
        if (!window.meshBus || !window.STATE?.did) return;
        window.meshBus.postMessage({
          type,
          payload,
          from: window.STATE.did,
          ts:   Date.now(),
        });
      },

      // Subscribe to incoming mesh messages of a specific type.
      // type '*' receives all incoming messages.
      meshListen: (type, fn) => {
        _meshListeners[type] = _meshListeners[type] ?? [];
        _meshListeners[type].push(fn);
      },

      // ── DAG convenience ───────────────────────────────────────────────────
      // Thin wrappers so modules don't need to know about _dagDB internals.
      dag: Object.freeze({
        put:  (node) => window._dagDB?.put('dag', node, node.cid),
        get:  (cid)  => window.ENOSStorage?.dag.get(cid),
        list: ()     => window.ENOSStorage?.dag.list(),
      }),

    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Mesh tap
  // Installs ONE onmessage override on meshBus that fans out to all
  // api.meshListen() registrations. Always calls the original handler first.
  // ──────────────────────────────────────────────────────────────────────────

  let _meshTapped = false;

  function _tapMeshBus () {
    if (_meshTapped || !window.meshBus) return;
    _meshTapped = true;

    const prev = window.meshBus.onmessage;
    window.meshBus.onmessage = function (e) {
      if (typeof prev === 'function') prev.call(window.meshBus, e);
      const type = e.data?.type;
      if (!type) return;
      const fns = (_meshListeners[type] ?? []).concat(_meshListeners['*'] ?? []);
      fns.forEach(fn => {
        try { fn(e.data); }
        catch (err) { console.warn('[ext-host] meshListen handler threw:', err); }
      });
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Module boot
  // ──────────────────────────────────────────────────────────────────────────

  function _boot (name, initFn, meta) {
    try {
      const api = _buildAPI();
      const mod = initFn(api) ?? {};
      REGISTRY.set(name, { meta, mod });
      console.info(`[ext-host] ✓ ${name}${meta.version ? '  v' + meta.version : ''}`);
      window.EventBus?.emit('SYS', { msg: `Module loaded: ${name}` });
    } catch (err) {
      console.error(`[ext-host] ✗ ${name}:`, err);
      window.EventBus?.emit('SYS', { msg: `Module failed: ${name} — ${err.message}` });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DOM ready handler
  //
  // setTimeout(0) yields after the foundation's own DOMContentLoaded handler,
  // which runs init() and creates STATE, EventBus, meshBus.
  // If meshBus still isn't ready after one tick (init() is async), a short
  // poll installs the tap once it appears.
  // ──────────────────────────────────────────────────────────────────────────

  function _onReady () {
    _ready = true;

    // Try to tap meshBus immediately
    _tapMeshBus();

    // If meshBus isn't live yet, poll until it is (init() is async)
    if (!_meshTapped) {
      let attempts = 0;
      const poll = setInterval(() => {
        _tapMeshBus();
        if (_meshTapped || ++attempts > 50) clearInterval(poll);
      }, 100);
    }

    // Flush queued registrations
    for (const { name, initFn, meta } of QUEUE) {
      _boot(name, initFn, meta);
    }
    QUEUE.length = 0;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(_onReady, 0));
  } else {
    // Already past DOMContentLoaded (dev reload, late injection)
    setTimeout(_onReady, 0);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public API — window.__ext
  // ──────────────────────────────────────────────────────────────────────────

  window.__ext = Object.freeze({

    /**
     * Register a module.
     *
     * @param {string}   name     Unique module id, e.g. 'cst', 'dex', 'nps'
     * @param {Function} initFn   Called with kernelAPI once DOM is ready.
     *                            Return a public API object or nothing.
     * @param {object}  [meta]    Optional { version, description }
     *
     * If called before DOM ready, registration is queued automatically.
     */
    register (name, initFn, meta = {}) {
      if (!name || typeof name !== 'string') {
        return console.warn('[ext-host] register() — name must be a non-empty string');
      }
      if (typeof initFn !== 'function') {
        return console.warn(`[ext-host] register('${name}') — initFn must be a function`);
      }
      if (REGISTRY.has(name)) {
        return console.warn(`[ext-host] "${name}" is already registered — skipping`);
      }
      _ready ? _boot(name, initFn, meta) : QUEUE.push({ name, initFn, meta });
    },

    /**
     * Get a registered module's public API.
     * @param  {string} name
     * @returns {object|null}
     */
    get (name) {
      return REGISTRY.get(name)?.mod ?? null;
    },

    /**
     * List all registered modules with their metadata.
     * @returns {{ name: string, version?: string, description?: string }[]}
     */
    modules () {
      return [...REGISTRY.entries()].map(([name, { meta }]) => ({ name, ...meta }));
    },

    version: '1.0.0',
  });

})();
