/**
 * SOVEREIGN NET OS — Preload Script
 * 
 * Exposes a minimal, safe API surface to the renderer via contextBridge.
 * The renderer has NO access to Node.js directly.
 * 
 * window.ipfs  — IPC bridge to the Kubo API (handled by main.js)
 * window.snos  — Utility helpers (app version, platform, etc.)
 */

const { contextBridge, ipcRenderer } = require('electron');

// ── IPFS API Bridge ────────────────────────────────────────────────────────
// Usage in renderer:
//   const { body } = await window.ipfs.api('/swarm/peers');
//   const { body } = await window.ipfs.api('/add', { formData: { file: { name: 'hello.txt', data: new TextEncoder().encode('hi') } } });

contextBridge.exposeInMainWorld('ipfs', {
  /**
   * Call any Kubo RPC endpoint.
   * @param {string}  apiPath  - e.g. '/swarm/peers'
   * @param {object}  opts
   * @param {string}  [opts.method]   - default 'POST'
   * @param {object}  [opts.query]    - URL search params, e.g. { arg: 'QmHash...' }
   * @param {object}  [opts.formData] - multipart fields, e.g. { file: { name, data: Uint8Array } }
   * @returns {Promise<{ ok: boolean, status: number, body: any }>}
   */
  api: (apiPath, opts = {}) => ipcRenderer.invoke('ipfs:api', { path: apiPath, ...opts }),

  /** Listen for daemon log lines forwarded from main process */
  onLog: (cb) => ipcRenderer.on('ipfs:log', (_e, line) => cb(line)),

  /** Remove all log listeners */
  offLog: () => ipcRenderer.removeAllListeners('ipfs:log'),

  // ── Convenience wrappers ────────────────────────────────────────────────

  /** GET /api/v0/version → { Version, Commit, ... } */
  version: () => ipcRenderer.invoke('ipfs:api', { path: '/version' }),

  /** GET live peer list → { Peers: [{ Addr, Peer, ... }] } */
  swarmPeers: () => ipcRenderer.invoke('ipfs:api', { path: '/swarm/peers' }),

  /** GET peer identity info → { ID, PublicKey, Addresses, ... } */
  id: () => ipcRenderer.invoke('ipfs:api', { path: '/id' }),

  /**
   * Add a file to IPFS.
   * @param {string}     name      - filename
   * @param {Uint8Array} data      - file bytes
   * @returns {Promise<{ Hash: string, Name: string, Size: string }>}
   */
  add: (name, data) => ipcRenderer.invoke('ipfs:api', {
    path: '/add',
    formData: { file: { name, data: Array.from(data) } }
  }),

  /**
   * Cat a CID from the gateway.
   * Returns the raw text/bytes via gateway (localhost:8080).
   * NOTE: this does a normal fetch since the gateway has no CORS issues
   * when we're serving from file:// or Electron.
   */
  cat: async (cid) => {
    const r = await fetch(`http://127.0.0.1:8080/ipfs/${cid}`);
    if (!r.ok) throw new Error(`Gateway error: ${r.status}`);
    return r.arrayBuffer();
  },

  /** Pin a CID */
  pin: (cid) => ipcRenderer.invoke('ipfs:api', { path: '/pin/add', query: { arg: cid } }),

  /** List pins */
  pins: () => ipcRenderer.invoke('ipfs:api', { path: '/pin/ls', query: { type: 'recursive' } }),

  /** Publish to a pubsub topic */
  pubsubPub: (topic, message) => ipcRenderer.invoke('ipfs:api', {
    path: '/pubsub/pub',
    query: { arg: [topic, message] }
  }),

  /** Subscribe to a pubsub topic (returns a ReadableStream via polling — see ipfsAdapter.js) */
  pubsubSub: (topic) => ipcRenderer.invoke('ipfs:api', {
    path: '/pubsub/sub',
    query: { arg: topic }
  }),

  /** IPNS publish — tie the current node's key to a CID */
  namePublish: (cid) => ipcRenderer.invoke('ipfs:api', { path: '/name/publish', query: { arg: cid } }),

  /** IPNS resolve a name to a CID */
  nameResolve: (name) => ipcRenderer.invoke('ipfs:api', { path: '/name/resolve', query: { arg: name } }),

  /** Repo stats → { NumObjects, RepoSize, ... } */
  repoStat: () => ipcRenderer.invoke('ipfs:api', { path: '/repo/stat' }),

  /** Bandwidth stats → { TotalIn, TotalOut, RateIn, RateOut } */
  statsBw: () => ipcRenderer.invoke('ipfs:api', { path: '/stats/bw' }),

  /** DHT find peers near a key */
  dhtFindPeer: (peerId) => ipcRenderer.invoke('ipfs:api', {
    path: '/dht/findpeer',
    query: { arg: peerId }
  }),

  // ── NAT Traversal helpers ───────────────────────────────────────────────

  /** Query AutoNAT status — returns { Reachability, PublicAddrs, ... } */
  autonatStatus: () => ipcRenderer.invoke('ipfs:api', { path: '/swarm/nat/status' }),

  /** List known relay addresses used by this node */
  relayAddrs: () => ipcRenderer.invoke('ipfs:api', { path: '/swarm/addrs/listen' }),
});

// ── App / OS helpers ───────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('snos', {
  platform:    process.platform,
  version:     process.env.npm_package_version || '0.1.0',
  isElectron:  true,
  ipfsApi:     'http://127.0.0.1:5001',
  ipfsGateway: 'http://127.0.0.1:8080'
});

// ── Peer Reputation API ────────────────────────────────────────────────────
// Scores range -100 (untrusted/banned) to +100 (highly trusted), start at 0.
contextBridge.exposeInMainWorld('peerRep', {
  /** Get all known peer reputations */
  getAll: () => ipcRenderer.invoke('rep:getAll'),

  /** Get one peer's { score, events, banned } */
  get: (peerId) => ipcRenderer.invoke('rep:get', peerId),

  /**
   * Submit a reputation event.
   * @param {string} peerId
   * @param {string} type   - event label e.g. 'connected', 'timeout', 'spam', 'goodContent'
   * @param {number} delta  - signed score change e.g. +5 or -10
   */
  event: (peerId, type, delta) => ipcRenderer.invoke('rep:event', { peerId, type, delta }),

  /** Manually ban or unban a peer */
  ban:   (peerId) => ipcRenderer.invoke('rep:ban', { peerId, ban: true }),
  unban: (peerId) => ipcRenderer.invoke('rep:ban', { peerId, ban: false }),

  /** Listen for auto-ban events triggered by the main process */
  onBanned: (cb) => ipcRenderer.on('peer:banned', (_e, data) => cb(data)),
});

// ── Bandwidth Constraint API ───────────────────────────────────────────────
contextBridge.exposeInMainWorld('bandwidth', {
  /** Get current { upload, download } byte/s limits (0 = unlimited) */
  getLimits: () => ipcRenderer.invoke('bw:getLimits'),

  /**
   * Set upload/download byte-per-second caps.
   * Pass 0 to remove a cap.  Propagated to Kubo ResourceManager at runtime.
   * @param {{ upload?: number, download?: number }} limits
   */
  setLimits: (limits) => ipcRenderer.invoke('bw:setLimits', limits),

  /**
   * Check whether an upload of fileSizeBytes is within the current upload cap.
   * Returns { allowed: boolean, rateOut: number, limit: number }
   */
  checkUpload: (fileSizeBytes) => ipcRenderer.invoke('bw:checkUpload', fileSizeBytes),

  /** Listen for limit changes pushed from main (e.g. after setLimits resolves) */
  onLimitsChanged: (cb) => ipcRenderer.on('bw:limitsChanged', (_e, data) => cb(data)),
});
