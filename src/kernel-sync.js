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

    // Persistent streaming subscription replaces the old polling approach.
    // pollMs is accepted for API compatibility but no longer drives receive.
    void pollMs;
    this._subActive     = false;
    this._subRetryDelay = 1_000;
    this._subReq        = null;
    this._startSubscription();

    console.log(`[kernel-sync] Started on topic: ${this.topic}`);
  }

  stop() {
    clearInterval(this._pollTimer);
    this._subActive = false;
    if (this._subReq) { try { this._subReq.destroy(); } catch (_) {} }
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

  // ──────────────────────────────────────────────────────────────────────────
  // SUBSCRIBE  — maintain a long-lived NDJSON stream from Kubo pubsub/sub
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Open (or re-open) a streaming subscription to the kernel topic.
   * Kubo's pubsub/sub endpoint returns one base64-encoded JSON object per line
   * (NDJSON). We parse each line and hand it to receive().
   *
   * On error or EOF we schedule a reconnect with exponential back-off, then
   * burst PULL_REQUESTs to any peers whose last-seen clock is stale by more
   * than PULL_STALE_THRESHOLD ticks.
   */
  _startSubscription() {
    if (this._subActive) return;
    this._subActive     = true;
    this._subRetryDelay = 1_000; // reset on explicit start
    this._connectStream();
  }

  _connectStream() {
    if (!this._subActive) return;

    const http = require("http");
    const topicEncoded = encodeURIComponent(this.topic);
    const options = {
      hostname: "127.0.0.1",
      port:     5001,
      path:     `/api/v0/pubsub/sub?arg=${topicEncoded}&discover=true`,
      method:   "POST",
    };

    const req = http.request(options, (res) => {
      this._subRetryDelay = 1_000; // successful connection → reset back-off
      let buf = "";

      res.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop(); // keep any incomplete trailing line
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            // Kubo wraps each message as { from, data, seqno, topicIDs }
            // where `data` is base64-encoded payload
            const msg = JSON.parse(line);
            if (msg?.data) {
              const envelope = this.decode(msg.data);
              if (envelope) {
                if (envelope.type === "PULL_REQUEST") {
                  this.handlePullRequest(envelope).catch(() => {});
                } else {
                  this.receive(envelope);
                }
              }
            }
          } catch (_) { /* malformed line — skip */ }
        }
      });

      res.on("end",   () => this._scheduleReconnect("stream ended"));
      res.on("error", () => this._scheduleReconnect("stream error"));
    });

    req.on("error", () => this._scheduleReconnect("connection failed"));
    req.setTimeout(0); // no timeout — this is intentionally long-lived
    req.end();

    this._subReq = req;
  }

  _scheduleReconnect(reason) {
    if (!this._subActive) return;
    console.warn(`[kernel-sync] Pubsub stream disconnected (${reason}), reconnecting in ${this._subRetryDelay}ms`);
    setTimeout(() => {
      this._burstPullRequests(); // catch up with any peers that advanced while we were offline
      this._connectStream();
    }, this._subRetryDelay);
    // Exponential back-off, capped at 30s
    this._subRetryDelay = Math.min(this._subRetryDelay * 2, 30_000);
  }

  /** Fire PULL_REQUESTs to peers whose last-seen clock is stale. */
  async _burstPullRequests() {
    const PULL_STALE_THRESHOLD = 10;
    for (const [peerId, theirClock] of this._peerClocks) {
      if (this.kernel.clock - theirClock > PULL_STALE_THRESHOLD) {
        await this.requestHistory(peerId, theirClock).catch(() => {});
      }
    }
  }

  // _pollPubsub is kept as a no-op so existing callers don't crash,
  // but all real work is done by the streaming subscriber above.
  async _pollPubsub() {}

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

    // Dedup — LRU eviction: once we exceed the cap we remove the oldest entries.
    // Using a Map instead of a Set gives us O(1) insertion-order iteration.
    if (!this._seenEnvelopesMap) {
      // Lazy-initialise the ordered map and retire the old Set if already seeded.
      this._seenEnvelopesMap = new Map();
      for (const id of this._seenEnvelopes) this._seenEnvelopesMap.set(id, true);
    }
    if (this._seenEnvelopesMap.has(envelope.id)) {
      return { ok: false, error: "Duplicate envelope" };
    }
    this._seenEnvelopesMap.set(envelope.id, true);
    const MAX_SEEN = 1000;
    if (this._seenEnvelopesMap.size > MAX_SEEN) {
      // Delete the oldest 200 entries in a single pass
      const iter = this._seenEnvelopesMap.keys();
      for (let i = 0; i < 200; i++) this._seenEnvelopesMap.delete(iter.next().value);
    }
    // Keep the legacy Set in sync so status() and other callers still work
    this._seenEnvelopes = new Set(this._seenEnvelopesMap.keys());

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
