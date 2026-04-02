"use strict";

/**
 * SOVEREIGN NET OS — Kernel Sync
 *
 * Peers exchange kernel events over IPFS pubsub.
 * Each node runs a sovereign kernel. Sync is opt-in, not required.
 *
 * Protocol:
 *   Topic:   sovereign-net/kernel/<channelId>
 *   Message: JSON envelope { nodeId, clock, events: [KernelEntry], sig? }
 *
 * Modes:
 *   BROADCAST  — push every committed event to the channel
 *   PULL       — request a peer's history since a given clock
 *   MERGE      — accept a peer's log and replay novel events into local kernel
 *
 * Security:
 *   - Events from remote peers go through the same SigPipeline as local events
 *   - The origin is set to "peer:<nodeId>" so validators can apply peer policy
 *   - Ban-listed peers are silently dropped (checked against kernel PEER_REP)
 *
 * This does NOT implement consensus — each node is sovereign.
 * Sync is eventual and additive: you accept events, not commands.
 */

const { KernelReplayer } = require("./kernel-replay");

// ─────────────────────────────────────────────────────────────────────────────

const TOPIC_PREFIX     = "sovereign-net/kernel/";
const SYNC_VERSION     = 1;
const MAX_EVENTS_BATCH = 50;    // max events per pubsub message
const PULL_TIMEOUT_MS  = 10_000;

// ─────────────────────────────────────────────────────────────────────────────

class KernelSync {
  /**
   * @param {DispatchKernel} kernel     — local kernel
   * @param {string}         nodeId     — this node's IPFS peer ID
   * @param {function}       ipfsPost   — httpPost helper from main.js
   * @param {string}         [channel]  — pubsub channel suffix (default "global")
   */
  constructor(kernel, nodeId, ipfsPost, channel = "global") {
    this.kernel    = kernel;
    this.nodeId    = nodeId;
    this.ipfsPost  = ipfsPost;
    this.channel   = channel;
    this.topic     = TOPIC_PREFIX + channel;
    this.replayer  = new KernelReplayer();

    this._pollTimer    = null;
    this._lastPushClock = -1;
    this._seenEnvelopes = new Set(); // dedup by envelope id
    this._peerClocks    = new Map(); // peerId → last known clock

    // Types that should NOT be broadcast to peers
    this._localOnly = new Set([
      "KERNEL_RESET_UNITS",
      "PEER_REP_DECAY",
      "IDENTITY_SET",     // identity is local
      "BW_SET_LIMITS",    // bandwidth policy is local
    ]);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // START / STOP
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Begin syncing.
   * @param {object} opts
   * @param {number} opts.broadcastMs  — how often to push new events (default 5000ms)
   * @param {number} opts.pollMs       — how often to poll pubsub (default 3000ms)
   */
  start({ broadcastMs = 5_000, pollMs = 3_000 } = {}) {
    // Broadcast new local events on interval
    setInterval(() => this._broadcastNewEvents(), broadcastMs);

    // Poll pubsub for incoming events
    setInterval(() => this._pollPubsub(), pollMs);

    console.log(`[kernel-sync] Started on topic: ${this.topic}`);
  }

  stop() {
    clearInterval(this._pollTimer);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // BROADCAST  — push local events to peers
  // ──────────────────────────────────────────────────────────────────────────

  async _broadcastNewEvents() {
    const history = this.kernel.replay();
    const newEvents = history.filter(e =>
      e.t > this._lastPushClock &&
      !this._localOnly.has(e.type) &&
      !["DISPATCH_REJECTED","DISPATCH_FAILED","DISPATCH_THROTTLED","DISPATCH_UNKNOWN"].includes(e.type)
    ).slice(-MAX_EVENTS_BATCH);

    if (newEvents.length === 0) return;

    const envelope = {
      v:      SYNC_VERSION,
      id:     `${this.nodeId}:${this.kernel.clock}:${Date.now()}`,
      nodeId: this.nodeId,
      clock:  this.kernel.clock,
      events: newEvents,
    };

    try {
      const encoded = this._encode(envelope);
      await this.ipfsPost(
        `http://127.0.0.1:5001/api/v0/pubsub/pub?arg=${encodeURIComponent(this.topic)}&arg=${encodeURIComponent(encoded)}`
      );
      this._lastPushClock = this.kernel.clock;
    } catch (err) {
      // pubsub unavailable — non-fatal, will retry next interval
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // POLL  — receive and apply peer events
  // ──────────────────────────────────────────────────────────────────────────

  async _pollPubsub() {
    try {
      const res = await this.ipfsPost(
        `http://127.0.0.1:5001/api/v0/pubsub/ls`
      );
      // Full streaming subscription isn't practical in this polling model.
      // A production implementation would use a WebSocket proxy or
      // a long-lived HTTP stream. This polls the topic's message buffer.
      // For now: just advertise presence by broadcasting; inbound messages
      // are received through the snos:peerMessage IPC channel from the renderer.
    } catch (_) {}
  }

  // ──────────────────────────────────────────────────────────────────────────
  // RECEIVE  — process an inbound envelope from a peer
  // Called from ipfsAdapter.js when a pubsub message arrives on the kernel topic
  // ──────────────────────────────────────────────────────────────────────────

  receive(envelope) {
    // Validate envelope
    if (!envelope?.v || !envelope?.nodeId || !Array.isArray(envelope?.events)) {
      return { ok: false, error: "Invalid envelope" };
    }
    if (envelope.v > SYNC_VERSION) {
      return { ok: false, error: "Unsupported protocol version" };
    }
    if (envelope.nodeId === this.nodeId) {
      return { ok: false, error: "Ignoring own message" }; // don't re-apply own events
    }

    // Dedup
    if (this._seenEnvelopes.has(envelope.id)) {
      return { ok: false, error: "Duplicate envelope" };
    }
    this._seenEnvelopes.add(envelope.id);
    if (this._seenEnvelopes.size > 1000) {
      // Trim oldest entries
      const iter = this._seenEnvelopes.values();
      for (let i = 0; i < 200; i++) this._seenEnvelopes.delete(iter.next().value);
    }

    // Check if peer is banned
    const rep = this.kernel.query("PEER_REP", envelope.nodeId);
    if (rep?.banned) {
      return { ok: false, error: "Peer is banned" };
    }

    // Apply novel events
    let applied = 0;
    let skipped = 0;
    const peerClock = this._peerClocks.get(envelope.nodeId) ?? -1;

    for (const entry of envelope.events) {
      // Skip events we've already seen from this peer
      if (entry.t <= peerClock) { skipped++; continue; }
      // Skip local-only event types
      if (this._localOnly.has(entry.type)) { skipped++; continue; }

      const result = this.kernel.dispatch({
        type:    entry.type,
        payload: entry.payload?.payload ?? entry.payload ?? {},
        origin:  `peer:${envelope.nodeId}`,
      });

      if (result.ok) {
        applied++;
      } else {
        skipped++;
      }
    }

    this._peerClocks.set(envelope.nodeId, envelope.clock);

    return { ok: true, applied, skipped, peerClock: envelope.clock };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PULL REQUEST  — ask a specific peer for their history
  // ──────────────────────────────────────────────────────────────────────────

  async requestHistory(peerId, sinceClock = 0) {
    const req = {
      v:       SYNC_VERSION,
      id:      `pull:${this.nodeId}:${Date.now()}`,
      nodeId:  this.nodeId,
      type:    "PULL_REQUEST",
      clock:   sinceClock,
      target:  peerId,
    };
    try {
      const encoded = this._encode(req);
      await this.ipfsPost(
        `http://127.0.0.1:5001/api/v0/pubsub/pub?arg=${encodeURIComponent(this.topic)}&arg=${encodeURIComponent(encoded)}`
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Handle a pull request from a peer — send them our history since their clock
  async handlePullRequest(req) {
    if (req.target !== this.nodeId) return; // not for us
    const history = this.kernel.replay().filter(e =>
      e.t > (req.clock ?? 0) &&
      !this._localOnly.has(e.type)
    ).slice(-MAX_EVENTS_BATCH * 4); // send up to 200 events

    const envelope = {
      v:       SYNC_VERSION,
      id:      `pull-resp:${this.nodeId}:${Date.now()}`,
      nodeId:  this.nodeId,
      clock:   this.kernel.clock,
      events:  history,
      inReplyTo: req.id,
    };
    try {
      const encoded = this._encode(envelope);
      await this.ipfsPost(
        `http://127.0.0.1:5001/api/v0/pubsub/pub?arg=${encodeURIComponent(this.topic)}&arg=${encodeURIComponent(encoded)}`
      );
    } catch (_) {}
  }

  // ──────────────────────────────────────────────────────────────────────────
  // UTILITIES
  // ──────────────────────────────────────────────────────────────────────────

  _encode(obj) {
    return Buffer.from(JSON.stringify(obj)).toString("base64");
  }

  decode(encoded) {
    try {
      return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
      return null;
    }
  }

  /** Status snapshot for the UI */
  status() {
    return {
      topic:       this.topic,
      nodeId:      this.nodeId,
      localClock:  this.kernel.clock,
      peerClocks:  Object.fromEntries(this._peerClocks),
      seenEnvelopes: this._seenEnvelopes.size,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────

function attachSyncBridge(kernelSync, ipcMain) {
  // Renderer can trigger a pull from a specific peer
  ipcMain.handle("kernel:sync:pull", async (_e, { peerId, sinceClock }) => {
    return kernelSync.requestHistory(peerId, sinceClock);
  });

  // Renderer delivers inbound pubsub messages to the sync engine
  ipcMain.handle("kernel:sync:receive", async (_e, { encoded }) => {
    const envelope = kernelSync.decode(encoded);
    if (!envelope) return { ok: false, error: "Decode failed" };
    return kernelSync.receive(envelope);
  });

  // Status
  ipcMain.handle("kernel:sync:status", async () => {
    return { ok: true, result: kernelSync.status() };
  });
}

module.exports = { KernelSync, attachSyncBridge };
