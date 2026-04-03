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
 * ZSAM.js — Zero-Signaling Autonomous P2P Mesh (partial)
 * Sovereign Net OS Extension Module
 *
 * Audit ruling — PARTIAL: the OS already has BroadcastChannel (browser),
 * WebRTC (Electron), and IPFS pubsub (Electron+Kubo) — the WebRTC code is
 * largely redundant. Post-quantum key exchange is simulation-only — skip it.
 * Two concepts are genuinely new:
 *
 *   ✓ Peer reputation  — float 0.0–1.0 per peer DID
 *                        incremented on communication, penalized for staleness
 *   ✓ Reputation-weighted routing — when sending, prefer peers with higher
 *                        reputation scores (top-N selection)
 *
 * Integration: ZSAM listens on the OS meshBus (BroadcastChannel) for PEER_JOIN,
 * ANNOUNCE_REPLY, PING, PONG, and custom application messages. It automatically
 * seeds/updates reputation from these existing signals.
 *
 * Usage:
 *   const zsam = window.__ext.get('zsam');
 *   zsam.updateReputation('did:key:abc', +0.05);
 *   zsam.getReputation('did:key:abc');       // → 0.87
 *   const best = zsam.topPeers(3);           // sorted by reputation descending
 *   zsam.sendWeighted(myData, topN = 3);     // broadcast to top-3 peers via meshBus
 */

window.__ext.register('zsam', function (api) {
  'use strict';

  // ─── Peer reputation store ────────────────────────────────────────────────
  // did → { reputation: float, lastSeen: ts, messagesExchanged: int }
  const _peers = new Map();

  const REPUTATION_CLAMP = { MIN: 0.0, MAX: 1.0 };
  const STALE_THRESHOLD  = 5 * 60_000;   // 5 min without activity → stale
  const STALE_PENALTY    = -0.02;
  const COMM_REWARD      = 0.01;

  // ─── Upsert / update ─────────────────────────────────────────────────────
  function _upsert (did) {
    if (!_peers.has(did)) _peers.set(did, { reputation: 0.5, lastSeen: Date.now(), messagesExchanged: 0 });
    return _peers.get(did);
  }

  /**
   * Adjust a peer's reputation by `delta` (positive or negative).
   * Result is clamped to [0.0, 1.0].
   * @param {string} did
   * @param {number} delta
   * @returns {number}  New reputation
   */
  function updateReputation (did, delta) {
    const peer = _upsert(did);
    peer.reputation = Math.max(REPUTATION_CLAMP.MIN, Math.min(REPUTATION_CLAMP.MAX, peer.reputation + delta));
    return peer.reputation;
  }

  function getReputation (did) {
    return _peers.get(did)?.reputation ?? null;
  }

  function recordActivity (did) {
    const peer  = _upsert(did);
    peer.lastSeen = Date.now();
    peer.messagesExchanged++;
    updateReputation(did, COMM_REWARD);
  }

  // ─── Top-N peers by reputation ────────────────────────────────────────────
  /**
   * Return peers sorted by reputation descending.
   * @param {number} n   Max results (0 = all)
   * @returns {{ did, reputation, lastSeen, messagesExchanged }[]}
   */
  function topPeers (n = 0) {
    const sorted = [..._peers.entries()]
      .map(([did, p]) => ({ did, ...p }))
      .sort((a, b) => b.reputation - a.reputation);
    return n > 0 ? sorted.slice(0, n) : sorted;
  }

  // ─── Reputation-weighted send via meshBus ────────────────────────────────
  /**
   * Broadcast a message to the top-N peers by reputation.
   * Uses the OS meshBus (BroadcastChannel) so no new transport is introduced.
   * @param {object} payload    Message data (will be wrapped with routing meta)
   * @param {number} topN       How many top-reputation peers to target (0 = all)
   * @returns {string[]}        DIDs targeted
   */
  function sendWeighted (payload, topN = 5) {
    const targets = topPeers(topN).map(p => p.did);
    if (!targets.length) return [];

    if (window.meshBus && window.STATE?.did) {
      window.meshBus.postMessage({
        type       : 'ZSAM_ROUTED',
        from       : window.STATE.did,
        targets,
        payload,
        ts         : Date.now(),
        reputations: Object.fromEntries(targets.map(d => [d, getReputation(d)])),
      });
    }
    return targets;
  }

  // ─── Tap OS meshBus to auto-update reputation ─────────────────────────────
  function _tapMeshBus () {
    const bus = window.meshBus;
    if (!bus) return false;

    bus.addEventListener('message', (ev) => {
      const msg = ev.data;
      if (!msg || !msg.from) return;
      const did = msg.from;

      switch (msg.type) {
        case 'ANNOUNCE':
        case 'ANNOUNCE_REPLY':
        case 'HELLO':
          _upsert(did);
          recordActivity(did);
          break;
        case 'PONG':
        case 'BLOCK':
        case 'DAG':
          recordActivity(did);
          break;
        case 'PING':
          // Mild reward — peer is alive
          updateReputation(did, 0.005);
          _upsert(did).lastSeen = Date.now();
          break;
        default:
          // Any traffic is mild positive signal
          if (_peers.has(did)) updateReputation(did, 0.003);
      }
    });

    return true;
  }

  // Try to tap immediately; poll if meshBus isn't ready yet
  if (!_tapMeshBus()) {
    let attempts = 0;
    const poll = setInterval(() => {
      if (_tapMeshBus() || ++attempts > 50) clearInterval(poll);
    }, 200);
  }

  // ─── Stale-peer decay (every 2 min) ──────────────────────────────────────
  setInterval(() => {
    const now = Date.now();
    _peers.forEach((peer, did) => {
      if (now - peer.lastSeen > STALE_THRESHOLD) {
        peer.reputation = Math.max(REPUTATION_CLAMP.MIN, peer.reputation + STALE_PENALTY);
      }
    });
  }, 2 * 60_000);

  api.emit('SYS', { msg: 'ZSAM online — peer reputation layer active (reputation-weighted routing)' });

  // ─── Public API ───────────────────────────────────────────────────────────
  return {
    updateReputation,
    getReputation,
    recordActivity,
    topPeers,
    sendWeighted,
    getAllPeers : () => [..._peers.entries()].map(([did, p]) => ({ did, ...p })),
    peerCount  : () => _peers.size,
  };

}, { version: '1.0.0', description: 'Zero-Signaling Autonomous P2P Mesh (partial) — peer reputation 0–1, updateReputation, reputation-weighted routing via meshBus' });
