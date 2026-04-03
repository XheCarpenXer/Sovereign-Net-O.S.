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
 * SOVEREIGN NET OS — Kubo Configuration Generator
 * kubo-config.js
 *
 * Generates a complete, battle-tested Kubo JSON config expressed as
 * ipfs config --json key-value pairs.  This mirrors what Helia's
 * libp2p-defaults.ts enables, translated into Kubo's config schema.
 *
 * Usage:
 *   const { applyKuboConfig } = require('./kubo-config');
 *   await applyKuboConfig(ipfsBinary, repoPath, onLog);
 *
 * Design notes:
 *   - Bootstrap list is sourced from Helia's bootstrappers.ts (maintained upstream).
 *   - Routing.Type "auto" uses both DHT client and delegated HTTP routing.
 *   - ConnMgr low/high watermarks prevent connection churn on home routers.
 *   - MDNS is enabled for LAN peer discovery (missing from the old NAT_CONFIG).
 *   - AutoNAT, DCUtR, RelayV2 client+server are all enabled explicitly.
 *   - Pubsub uses GossipSub (better than FloodSub for sparse topologies).
 *   - CORS is set to allow the Electron renderer (localhost / file://).
 */

'use strict';

const { spawn } = require('child_process');

// ── Bootstrap peers (from Helia bootstrappers.ts / Kubo bootstrap_peers.go) ──
// These are the canonical libp2p.io bootstrap nodes.  Keep this list in sync
// with https://github.com/ipfs/kubo/blob/master/config/bootstrap_peers.go
const BOOTSTRAP_PEERS = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
  // va1 — not yet in TXT records, use host directly (from Helia bootstrappers.ts comment)
  '/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8',
  // Fallback IP4 bootstrap (legacy, highly reliable)
  '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
];

// ── Full Kubo config map ───────────────────────────────────────────────────
// Each entry: [kuboConfigKey, value]
// Applied via: ipfs config --json <key> <JSON-value>
//
// Sections:
//   Bootstrap          — entry peers for DHT bootstrap
//   Routing            — DHT mode + delegated HTTP routing
//   Discovery.MDNS     — LAN peer discovery (was missing from old NAT_CONFIG)
//   Swarm.ConnMgr      — connection manager watermarks (prevents churn)
//   AutoNAT            — service mode (advertise + detect)
//   Swarm.Transports   — enable relay transport
//   Swarm.*Relay*      — RelayV2 client + server
//   Swarm.EnableHolePunching — DCUtR
//   Pubsub             — GossipSub enabled
//   API.HTTPHeaders    — CORS for Electron renderer

function buildConfigEntries() {
  return [
    // ── Bootstrap ──────────────────────────────────────────────────────────
    ['Bootstrap', BOOTSTRAP_PEERS],

    // ── Routing ────────────────────────────────────────────────────────────
    // "auto" = DHT client by default, upgrades to server when publicly reachable.
    // This is what Kubo ships with in newer versions; older installs default to
    // "dht" (full server) which hammers home routers.  "auto" is safer and faster.
    ['Routing.Type', 'auto'],

    // Enable delegated HTTP routing (cid.contact — same as Helia's delegatedRouting service)
    ['Routing.DelegatedRouters', [
      {
        Type: 'HTTP',
        Parameters: {
          Endpoint: 'https://delegated-ipfs.dev',
        },
      },
    ]],

    // ── MDNS (LAN discovery) ───────────────────────────────────────────────
    // Was NOT in the old NAT_CONFIG — this is the highest-value fix for local
    // networks (offices, homes, same-subnet Electron instances).
    ['Discovery.MDNS.Enabled', true],
    ['Discovery.MDNS.Interval', 10],  // seconds between mDNS queries

    // ── Connection Manager ─────────────────────────────────────────────────
    // Low: start pruning when connections exceed this.
    // High: target to prune down to.
    // GracePeriod: don't close connections younger than this (seconds).
    // These values prevent connection churn on consumer NAT devices.
    ['Swarm.ConnMgr.Type', 'basic'],
    ['Swarm.ConnMgr.LowWater', 20],
    ['Swarm.ConnMgr.HighWater', 40],
    ['Swarm.ConnMgr.GracePeriod', '20s'],

    // ── AutoNAT ────────────────────────────────────────────────────────────
    // "enabled" = this node both checks its own reachability AND helps other
    // peers check theirs.  This feeds the "auto" routing mode above.
    ['AutoNAT.ServiceMode', 'enabled'],

    // ── UPnP / NAT port mapping ────────────────────────────────────────────
    ['Swarm.DisableNatPortMap', false],

    // ── Circuit Relay V2 ───────────────────────────────────────────────────
    // Client: use public relay nodes when direct connection fails.
    // Server: act as a relay for other peers (reciprocal — improves network).
    // Transport: must be enabled for the relay to work at the transport layer.
    ['Swarm.RelayClient.Enabled', true],
    ['Swarm.RelayService.Enabled', true],
    ['Swarm.Transports.Network.Relay', true],

    // ── Hole Punching (DCUtR) ──────────────────────────────────────────────
    // Direct Connection Upgrade through Relay — punches through symmetric NAT.
    ['Swarm.EnableHolePunching', true],

    // ── Pubsub ─────────────────────────────────────────────────────────────
    // Enable pubsub and use GossipSub (better than FloodSub for sparse meshes).
    ['Pubsub.Enabled', true],
    ['Pubsub.Router', 'gossipsub'],

    // ── API CORS (Electron renderer access) ───────────────────────────────
    ['API.HTTPHeaders.Access-Control-Allow-Origin',  ['*']],
    ['API.HTTPHeaders.Access-Control-Allow-Methods', ['PUT', 'POST', 'GET']],

    // ── Addresses ─────────────────────────────────────────────────────────
    // Listen on all interfaces (IPv4 + IPv6) so MDNS and direct connections work.
    ['Addresses.Swarm', [
      '/ip4/0.0.0.0/tcp/4001',
      '/ip6/::/tcp/4001',
      '/ip4/0.0.0.0/udp/4001/quic-v1',
      '/ip6/::/udp/4001/quic-v1',
      '/ip4/0.0.0.0/udp/4001/quic-v1/webtransport',
    ]],
  ];
}

// ── Apply all config entries via `ipfs config --json` ─────────────────────
/**
 * @param {string}   bin      - path to the ipfs binary
 * @param {string}   repoPath - IPFS_PATH (repo directory)
 * @param {Function} onLog    - log callback (string) => void
 */
async function applyKuboConfig(bin, repoPath, onLog) {
  const env     = { ...process.env, IPFS_PATH: repoPath };
  const entries = buildConfigEntries();

  onLog(`Applying ${entries.length} Kubo config entries…`);

  for (const [key, value] of entries) {
    const jsonValue = JSON.stringify(value);
    await new Promise((resolve) => {
      const p = spawn(bin, ['config', '--json', key, jsonValue], { env });
      const lines = [];
      p.stderr.on('data', d => lines.push(d.toString().trim()));
      p.on('close', code => {
        if (code !== 0 && lines.length) {
          onLog(`  [config] ${key}: ${lines.join(' ')}`);
        }
        resolve(); // non-fatal — older Kubo versions may not know every key
      });
    });
  }

  onLog('✓ Kubo config applied (bootstrap + DHT + MDNS + ConnMgr + NAT + RelayV2 + GossipSub)');
}

module.exports = { applyKuboConfig, BOOTSTRAP_PEERS };
