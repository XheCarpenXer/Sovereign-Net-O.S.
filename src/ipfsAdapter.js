/**
 * SOVEREIGN NET OS — IPFS Adapter
 * ipfsAdapter.js  (loaded at the bottom of index.html when running in Electron)
 *
 * This module detects whether window.ipfs (the Electron preload bridge) is
 * available and, if so, overrides the simulated subsystems with real Kubo calls.
 *
 * HOW TO ADD TO index.html:
 *   Before </body>, add:
 *     <script src="src/ipfsAdapter.js"></script>
 *
 * WHAT GETS WIRED UP:
 *   1.  Real peer list from swarm/peers → STATE.peers
 *   2.  Real node identity from /id → STATE.did, STATE.handle
 *   3.  Real file add/cat → Files view
 *   4.  Real pubsub → Messenger channels
 *   5.  Real bandwidth / repo stats → Home stats panel
 *   6.  Daemon log forwarding → Console view
 *   7.  Polling refresh for all live data
 */

(function () {
  'use strict';

  // Only activate when running inside our Electron app
  if (!window.snos?.isElectron || !window.ipfs) return;

  console.log('[IPFS Adapter] Electron detected — wiring real Kubo API');

  // ── Namespace-safe EventBus proxy ────────────────────────────────────────
  function emit(type, msg) {
    if (window.EventBus?.emit) EventBus.emit(type, { msg });
  }

  // ── Toast proxy ──────────────────────────────────────────────────────────
  function toast(msg, type = 'c') {
    if (window.showToast) showToast(msg, type);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  1. NODE IDENTITY
  //     Replace the simulated DID with the real IPFS peer ID.
  // ════════════════════════════════════════════════════════════════════════
  async function syncIdentity() {
    try {
      const { ok, body } = await window.ipfs.id();
      if (!ok) return;

      const peerId = body.ID;
      const did    = `did:ipfs:${peerId}`;

      // Patch STATE
      if (window.STATE) {
        STATE.did    = did;
        STATE.handle = STATE.handle || peerId.slice(0, 12);
      }

      // Update UI elements that show our DID
      ['tbDID', 'idDid', 'profileDid'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = did;
      });

      const verEl = document.getElementById('idVersion');
      if (verEl) {
        const { body: ver } = await window.ipfs.version();
        if (ver?.Version) verEl.textContent = `Kubo v${ver.Version}`;
      }

      emit('SYS', `Node identity: ${did.slice(0, 36)}...`);
    } catch (e) {
      emit('SYS', `Identity sync failed: ${e.message}`);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  2. REAL PEER LIST
  //     Replaces generatePeers() with live swarm/peers data.
  //     Also attaches reputation scores and enforces bandwidth-based filtering.
  // ════════════════════════════════════════════════════════════════════════
  async function syncPeers() {
    try {
      const { ok, body } = await window.ipfs.swarmPeers();
      if (!ok || !body?.Peers) return;

      // Fetch reputation snapshot (non-blocking — fails gracefully)
      let repTable = {};
      try { repTable = (await window.peerRep?.getAll()) || {}; } catch (_) {}

      const realPeers = (body.Peers || []).map((p, i) => {
        const peerId  = p.Peer;
        const shortId = peerId.slice(0, 8);
        const rep     = repTable[peerId] || { score: 0, banned: false };

        return {
          id:        `peer_${i}`,
          did:       `did:ipfs:${peerId}`,
          peerId,
          name:      shortId + '.ipfs',
          handle:    shortId,
          avi:       window.pickAvi   ? pickAvi(`did:ipfs:${peerId}`)   : '📡',
          color:     window.pickColor ? pickColor(`did:ipfs:${peerId}`) : 'rgba(0,212,255,0.15)',
          latency:   p.Latency ? Math.round(parseFloat(p.Latency) / 1e6) : null, // ns → ms
          online:    true,
          addr:      p.Addr,
          // ── Reputation fields ─────────────────────────────────────────
          repScore:  rep.score,
          banned:    rep.banned,
          trusted:   rep.score >= 50,
          x: Math.random(), y: Math.random(),
          vx: (Math.random() - 0.5) * 0.002, vy: (Math.random() - 0.5) * 0.002
        };
      }).filter(p => !p.banned);   // exclude banned peers from the active list

      if (window.STATE && realPeers.length > 0) {
        STATE.peers = realPeers;
        if (window.renderHomePeers)  renderHomePeers();
        if (window.renderPeerList)   renderPeerList();
        if (window.updatePeerCounts) updatePeerCounts();
      }

      // Award small positive rep for peers that stayed connected
      for (const p of realPeers) {
        if (p.latency !== null && p.latency < 500) {
          window.peerRep?.event(p.peerId, 'lowLatency', 1).catch(() => {});
        }
      }

      emit('NET', `Swarm: ${realPeers.length} real IPFS peers`);
    } catch (e) {
      emit('NET', `Peer sync failed: ${e.message}`);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  2b. NAT TRAVERSAL STATUS
  //      Polls AutoNAT reachability and surfaces relay addrs in the UI.
  // ════════════════════════════════════════════════════════════════════════
  async function syncNatStatus() {
    try {
      // /swarm/nat/status — available in Kubo ≥ 0.18
      const { ok, body } = await window.ipfs.autonatStatus?.() || {};
      if (!ok) return;

      // body: { Reachability: "Public" | "Private" | "Unknown", PublicAddrs: [...] }
      const reachability = body?.Reachability ?? 'Unknown';
      const isPublic     = reachability === 'Public';
      const isPrivate    = reachability === 'Private';   // behind NAT, using relay

      // Emit to the console / event bus
      emit('NET', `NAT: ${reachability}${isPrivate ? ' (relay active)' : ''}`);

      // Update UI badge if present
      const natEl = document.getElementById('stat-nat') || document.getElementById('natStatus');
      if (natEl) {
        natEl.textContent = reachability;
        natEl.style.color = isPublic ? '#00d4ff' : isPrivate ? '#ffd700' : '#888';
      }

      // If behind NAT and not yet relaying, warn the user once
      if (isPrivate && !syncNatStatus._warnedRelay) {
        syncNatStatus._warnedRelay = true;
        toast('NAT detected — using Circuit Relay for connectivity', 'c');
      }
    } catch (_) {}
  }
  syncNatStatus._warnedRelay = false;

  // ════════════════════════════════════════════════════════════════════════
  //  3. REAL FILE ADD / CAT
  //     Patches the Files view upload handler.
  //     Respects bandwidth constraints before uploading.
  // ════════════════════════════════════════════════════════════════════════
  function patchFileUpload() {
    // Override the file input handler if it exists
    const fileInput = document.getElementById('fileUploadInput') ||
                      document.querySelector('input[type="file"]');
    if (!fileInput) return;

    // Clone to remove old listeners
    const fresh = fileInput.cloneNode(true);
    fileInput.parentNode?.replaceChild(fresh, fileInput);

    fresh.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;

      for (const file of files) {
        // ── Bandwidth gate ────────────────────────────────────────────────
        if (window.bandwidth) {
          try {
            const check = await window.bandwidth.checkUpload(file.size);
            if (!check.allowed) {
              const limitMb = (check.limit / 1e6).toFixed(1);
              const rateMb  = (check.rateOut / 1e6).toFixed(1);
              toast(`Upload blocked: BW cap ${limitMb} MB/s (current ${rateMb} MB/s)`, 'r');
              emit('NET', `Upload of ${file.name} blocked by BW constraint`);
              continue;
            }
          } catch (_) { /* non-fatal */ }
        }

        toast(`Uploading ${file.name} to IPFS…`, 'c');
        try {
          const buf = new Uint8Array(await file.arrayBuffer());
          const { ok, body } = await window.ipfs.add(file.name, buf);
          if (!ok) throw new Error('Add failed');
          const cid = body.Hash;
          toast(`✓ ${file.name} → ${cid.slice(0, 20)}…`, 'g');
          emit('FILE', `Added ${file.name} → CID: ${cid}`);

          // Inject into FILES view list if the function exists
          if (window.addFileToView) {
            addFileToView({ name: file.name, cid, size: file.size, ts: Date.now() });
          } else {
            if (window.STATE?.files) {
              STATE.files.unshift({ name: file.name, cid, size: file.size, ts: Date.now(), pinned: false });
              if (window.renderFileList) renderFileList();
            }
          }
        } catch (err) {
          toast(`Upload failed: ${err.message}`, 'r');
        }
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  //  4. REAL PUBSUB → MESSENGER  (Phase 3 upgrade — streaming, not polling)
  //     Topic format: sovereign-net/<channelId>
  //
  //  Architecture:
  //    Publish:   renderer → pubsubPub → main → Kubo POST /pubsub/pub
  //    Subscribe: main holds a PERSISTENT streaming HTTP connection to
  //               Kubo /api/v0/pubsub/sub, decodes each newline-delimited
  //               JSON message, and pushes it here via ipcRenderer
  //               ('pubsub:msg').  No more polling — messages arrive in
  //               real time as Kubo delivers them over GossipSub.
  // ════════════════════════════════════════════════════════════════════════

  const PUBSUB_TOPIC_PREFIX = 'sovereign-net/';
  const activeTopics        = new Set(); // channelIds with live streams

  // ── Global message router ────────────────────────────────────────────────
  // Registered once at boot.  Receives ALL subscribed topics and dispatches
  // to the right channel in the messenger UI.
  window.ipfs.onPubsubMsg(({ topic, from, data }) => {
    if (!topic.startsWith(PUBSUB_TOPIC_PREFIX)) return;
    const channelId = topic.slice(PUBSUB_TOPIC_PREFIX.length);

    let payload;
    try { payload = JSON.parse(data); } catch (_) { return; }

    // Skip our own echoed messages
    if (payload.did && payload.did === window.STATE?.did) return;

    const msg = {
      id:       payload.id     || crypto.randomUUID(),
      channelId,
      did:      payload.did    || `did:ipfs:${(from || 'unknown').slice(0, 12)}`,
      handle:   payload.handle || (from || 'anon').slice(0, 8),
      text:     payload.text   || '',
      ts:       payload.ts     || Date.now(),
      fromPeer: true,
    };

    // Append to STATE and re-render if this channel is active
    if (window.STATE?.messages) {
      if (!STATE.messages[channelId]) STATE.messages[channelId] = [];
      STATE.messages[channelId].push(msg);
    }
    if (window.STATE?.activeChannel === channelId && window.renderMessages) {
      renderMessages(channelId);
    }

    emit('MSG', `[${channelId}] ${msg.handle}: ${msg.text.slice(0, 60)}`);
  });

  /**
   * Override meshSendPublic to publish via IPFS GossipSub.
   * Signature is preserved so nothing else in the app breaks.
   */
  const _origMeshSendPublic = window.meshSendPublic;
  window.meshSendPublic = async function (channelId, text) {
    const topic   = PUBSUB_TOPIC_PREFIX + channelId;
    const payload = JSON.stringify({
      id:        crypto.randomUUID(),
      channelId,
      did:       window.STATE?.did    || 'unknown',
      handle:    window.STATE?.handle || 'anon',
      text,
      ts:        Date.now(),
    });
    try {
      // Kubo expects the message body as base64
      const encoded = btoa(unescape(encodeURIComponent(payload)));
      await window.ipfs.pubsubPub(topic, encoded);
    } catch (e) {
      // Fall back to BroadcastChannel mesh if IPFS pubsub unavailable
      if (_origMeshSendPublic) return _origMeshSendPublic(channelId, text);
    }
  };

  /**
   * Open a persistent streaming subscription for a channel (idempotent).
   * Message delivery happens in the global router above.
   */
  async function startPubsubStream(channelId) {
    if (activeTopics.has(channelId)) return;
    const topic = PUBSUB_TOPIC_PREFIX + channelId;
    try {
      await window.ipfs.pubsubSubscribe(topic);
      activeTopics.add(channelId);
      emit('NET', `Subscribed to pubsub stream: ${topic}`);
    } catch (e) {
      emit('NET', `Pubsub subscribe failed for ${channelId}: ${e.message}`);
    }
  }

  /** Wire up pubsub streaming when a channel is opened */
  const _origSwitchChannel = window.switchChannel;
  window.switchChannel = function (id) {
    if (_origSwitchChannel) _origSwitchChannel(id);
    startPubsubStream(id);
  };

  // ════════════════════════════════════════════════════════════════════════
  //  5. REAL STATS → HOME + NETWORK VIEW
  // ════════════════════════════════════════════════════════════════════════
  async function syncStats() {
    try {
      const [bwRes, repoRes] = await Promise.all([
        window.ipfs.statsBw(),
        window.ipfs.repoStat()
      ]);

      if (bwRes.ok && bwRes.body) {
        const { TotalIn, TotalOut, RateIn, RateOut } = bwRes.body;
        const fmt = n => n > 1e9 ? (n/1e9).toFixed(1)+'GB' : n > 1e6 ? (n/1e6).toFixed(1)+'MB' : (n/1e3).toFixed(0)+'KB';
        const el = document.getElementById('stat-bandwidth');
        if (el) el.textContent = `↑${fmt(TotalOut)} ↓${fmt(TotalIn)}`;
        emit('NET', `BW: ↑${fmt(TotalOut)} ↓${fmt(TotalIn)} | Rate: ↑${fmt(RateOut)}/s ↓${fmt(RateIn)}/s`);
      }

      if (repoRes.ok && repoRes.body) {
        const { NumObjects, RepoSize } = repoRes.body;
        const mb = (RepoSize / 1e6).toFixed(1);
        const storEl = document.getElementById('stat-storage');
        if (storEl) storEl.textContent = `${mb} MB`;
        const objEl = document.getElementById('stat-objects');
        if (objEl) objEl.textContent = NumObjects;
      }
    } catch (_) {}
  }

  // ════════════════════════════════════════════════════════════════════════
  //  5b. BANDWIDTH STATS → HOME + NETWORK VIEW (extended)
  //      Shows current limits alongside usage when caps are set.
  // ════════════════════════════════════════════════════════════════════════
  async function syncBandwidthLimits() {
    if (!window.bandwidth) return;
    try {
      const { upload, download } = await window.bandwidth.getLimits();
      const fmt = n => n === 0 ? '∞' : n > 1e6 ? (n/1e6).toFixed(1)+' MB/s' : (n/1e3).toFixed(0)+' KB/s';
      const limEl = document.getElementById('stat-bw-limit');
      if (limEl) limEl.textContent = `↑${fmt(upload)} ↓${fmt(download)}`;
    } catch (_) {}
  }

  // Listen for limit changes pushed from main process
  window.bandwidth?.onLimitsChanged?.(({ upload, download }) => {
    const fmt = n => n === 0 ? '∞' : n > 1e6 ? (n/1e6).toFixed(1)+' MB/s' : (n/1e3).toFixed(0)+' KB/s';
    emit('NET', `BW limits updated: ↑${fmt(upload)} ↓${fmt(download)}`);
    syncBandwidthLimits();
  });

  // ════════════════════════════════════════════════════════════════════════
  //  5c. PEER REPUTATION — passive event hooks
  // ════════════════════════════════════════════════════════════════════════

  // Listen for auto-bans triggered in main process
  window.peerRep?.onBanned?.(({ peerId, score }) => {
    toast(`⛔ Peer ${peerId.slice(0, 12)}… auto-banned (score ${score})`, 'r');
    emit('NET', `Peer ${peerId} banned — reputation score ${score}`);
    // Re-render peer list so banned peer disappears immediately
    syncPeers();
  });

  /** Public helper: let other parts of the app submit reputation events */
  window.reportPeer = async function (peerId, type, delta) {
    try {
      const rep = await window.peerRep?.event(peerId, type, delta);
      if (rep?.banned) {
        toast(`⛔ ${peerId.slice(0, 12)}… banned`, 'r');
        syncPeers();
      }
      return rep;
    } catch (e) {
      console.warn('[repAdapter] reportPeer failed:', e.message);
    }
  };
  // ════════════════════════════════════════════════════════════════════════
  window.ipfs.onLog(line => {
    emit('SYS', `[kubo] ${line.slice(0, 120)}`);

    // Also push to console view's log textarea if it exists
    const logEl = document.getElementById('consoleLog') ||
                  document.getElementById('daemonLog');
    if (logEl && logEl.tagName === 'TEXTAREA') {
      logEl.value += line + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  //  7. BOOT SEQUENCE + POLLING
  // ════════════════════════════════════════════════════════════════════════
  async function boot() {
    emit('SYS', 'IPFS Adapter booting…');
    toast('Connecting to Kubo daemon…', 'c');

    await syncIdentity();
    await syncPeers();
    await syncStats();
    await syncNatStatus();
    await syncBandwidthLimits();
    patchFileUpload();

    // ── Subscribe to the active channel (and global) at startup ─────────────
    // This ensures pubsub streams are open before the user types anything.
    const defaultChannel = window.STATE?.activeChannel || 'global';
    await startPubsubStream(defaultChannel);
    if (defaultChannel !== 'global') await startPubsubStream('global');

    toast('✓ IPFS Adapter active', 'g');
    emit('SYS', 'IPFS Adapter ready — real network active');

    // Periodic refresh
    setInterval(syncPeers,          15000);   // peers + reputation every 15 s
    setInterval(syncStats,          10000);   // bandwidth usage every 10 s
    setInterval(syncNatStatus,      30000);   // NAT reachability every 30 s
    setInterval(syncBandwidthLimits, 60000);  // BW limits (rarely change) every 60 s
  }

  // Boot after the main app initialises (give it 1 second)
  setTimeout(boot, 1000);

})();
