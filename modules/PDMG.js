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
 * PDMG.js — Persistent Distributed Memory Graph
 * Sovereign Net OS Extension Module
 *
 * Fills gap: the OS DAG only stores code commits. PDMG turns it into a proper
 * knowledge graph with typed nodes and edges. Agents can hold beliefs, dispute
 * facts, and have causation chains traced.
 *
 * What this adds:
 *   - Typed nodes: EVENT, BELIEF, FACT, EPHEMERAL, AGENT_MEMORY
 *   - Typed edges: CAUSES, SUPPORTS, CONTRADICTS, TEMPORAL, REFERENCE
 *   - Trust scores on nodes
 *   - Temporal overlay (nodes in time order)
 *   - Causal chain tracing (depth-limited BFS following CAUSES edges)
 *   - Temporal-Merit conflict resolution (trust score wins; recency breaks ties)
 *   - mergeRemoteGraph() — CRDT-style merge with conflict stats
 *   - Merkle root over active node hashes
 *
 * Usage:
 *   const pdmg = window.__ext.get('pdmg');
 *   const fact = await pdmg.addNode('FACT', 'Network stable', { trustScore: 1.0 });
 *   const ev   = await pdmg.addNode('EVENT', 'Peer joined');
 *   pdmg.addEdge(ev.id, fact.id, 'SUPPORTS');
 *   pdmg.getCausalOverlay(ev.id);
 *   pdmg.getTemporalOverlay();
 */

window.__ext.register('pdmg', function (api) {
  'use strict';

  // ─── Types ────────────────────────────────────────────────────────────────
  const NodeType = Object.freeze({
    EVENT       : 'EVENT',
    BELIEF      : 'BELIEF',
    FACT        : 'FACT',
    EPHEMERAL   : 'EPHEMERAL',
    AGENT_MEMORY: 'AGENT_MEMORY',
  });

  const EdgeType = Object.freeze({
    CAUSES    : 'CAUSES',
    SUPPORTS  : 'SUPPORTS',
    CONTRADICTS: 'CONTRADICTS',
    TEMPORAL  : 'TEMPORAL',
    REFERENCE : 'REFERENCE',
  });

  // ─── State ────────────────────────────────────────────────────────────────
  const nodes = new Map();
  const edges = new Map();
  let   merkleRoot  = null;
  const vectorClock = {};

  // ─── GraphNode ────────────────────────────────────────────────────────────
  class GraphNode {
    constructor (type, content, meta = {}) {
      this.id      = crypto.randomUUID();
      this.type    = type;
      this.content = content;
      this.meta    = {
        created   : Date.now(),
        modified  : Date.now(),
        author    : meta.author    ?? 'local',
        trustScore: meta.trustScore ?? 1.0,
        version   : 1,
        ...meta,
      };
      this.hash    = null;
      this.deleted = false;
    }
    async computeHash () {
      const enc  = new TextEncoder();
      const data = enc.encode(this.id + this.type + JSON.stringify(this.content) + this.meta.created);
      const buf  = await crypto.subtle.digest('SHA-256', data);
      this.hash  = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      return this.hash;
    }
    toJSON () {
      return { id: this.id, type: this.type, content: this.content, meta: this.meta, hash: this.hash, deleted: this.deleted };
    }
  }

  // ─── GraphEdge ────────────────────────────────────────────────────────────
  class GraphEdge {
    constructor (sourceId, targetId, type, weight = 1.0) {
      this.id       = crypto.randomUUID();
      this.sourceId = sourceId;
      this.targetId = targetId;
      this.type     = type;
      this.weight   = weight;
      this.created  = Date.now();
      this.deleted  = false;
    }
    toJSON () {
      return { id: this.id, sourceId: this.sourceId, targetId: this.targetId, type: this.type, weight: this.weight, created: this.created, deleted: this.deleted };
    }
  }

  // ─── Vector clock ─────────────────────────────────────────────────────────
  function _tick (nodeId) { vectorClock[nodeId] = (vectorClock[nodeId] ?? 0) + 1; }
  function _mergeClock (remote) {
    Object.keys(remote).forEach(k => { vectorClock[k] = Math.max(vectorClock[k] ?? 0, remote[k]); });
  }

  // ─── Merkle root ──────────────────────────────────────────────────────────
  async function _computeMerkle () {
    let level = [...nodes.values()].filter(n => !n.deleted && n.hash).map(n => n.hash).sort();
    if (!level.length) { merkleRoot = '0'.repeat(64); return merkleRoot; }
    const enc = new TextEncoder();
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        const combined = enc.encode(level[i] + (level[i + 1] ?? level[i]));
        const buf  = await crypto.subtle.digest('SHA-256', combined);
        next.push(Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''));
      }
      level = next;
    }
    merkleRoot = level[0];
    return merkleRoot;
  }

  // ─── Add / update / delete ────────────────────────────────────────────────
  async function addNode (type, content, meta = {}) {
    const node = new GraphNode(type, content, meta);
    await node.computeHash();
    nodes.set(node.id, node);
    _tick(node.id);
    await _computeMerkle();
    api.emit('SYS', { msg: `PDMG: node added [${type}]` });
    return node.toJSON();
  }

  function addEdge (sourceId, targetId, type, weight = 1.0) {
    if (!nodes.has(sourceId) || !nodes.has(targetId))
      throw new Error('PDMG: source or target node not found');
    const edge = new GraphEdge(sourceId, targetId, type, weight);
    edges.set(edge.id, edge);
    return edge.toJSON();
  }

  async function updateNode (nodeId, updates) {
    const node = nodes.get(nodeId);
    if (!node) throw new Error('PDMG: node not found');
    node.content      = { ...node.content, ...updates.content };
    node.meta.modified = Date.now();
    node.meta.version++;
    await node.computeHash();
    _tick(nodeId);
    await _computeMerkle();
    return node.toJSON();
  }

  function deleteNode (nodeId) {
    const node = nodes.get(nodeId);
    if (!node) return false;
    node.deleted = true;
    node.meta.modified = Date.now();
    edges.forEach(e => { if (e.sourceId === nodeId || e.targetId === nodeId) e.deleted = true; });
    return true;
  }

  // ─── Query ────────────────────────────────────────────────────────────────
  function queryNodes (filter = {}) {
    let results = [...nodes.values()].filter(n => !n.deleted);
    if (filter.type)     results = results.filter(n => n.type === filter.type);
    if (filter.author)   results = results.filter(n => n.meta.author === filter.author);
    if (filter.minTrust) results = results.filter(n => n.meta.trustScore >= filter.minTrust);
    if (filter.since)    results = results.filter(n => n.meta.created >= filter.since);
    return results.map(n => n.toJSON());
  }

  // ─── Overlays ─────────────────────────────────────────────────────────────
  function getTemporalOverlay () {
    return [...nodes.values()].filter(n => !n.deleted)
      .sort((a, b) => a.meta.created - b.meta.created)
      .map(n => ({ id: n.id, type: n.type, timestamp: n.meta.created, hash: n.hash?.slice(0, 8) }));
  }

  function getCausalOverlay (nodeId, maxDepth = 10) {
    const visited = new Set();
    const chain   = [];
    function trace (id, depth) {
      if (visited.has(id) || depth > maxDepth) return;
      visited.add(id);
      const node = nodes.get(id);
      if (node && !node.deleted) {
        chain.push({ ...node.toJSON(), depth });
        edges.forEach(e => {
          if (!e.deleted && e.type === 'CAUSES' && e.sourceId === id) trace(e.targetId, depth + 1);
        });
      }
    }
    trace(nodeId, 0);
    return chain;
  }

  function getGraphData () {
    return {
      nodes: [...nodes.values()].filter(n => !n.deleted).map(n => ({
        id: n.id, type: n.type,
        label: typeof n.content === 'string' ? n.content.slice(0, 30) : n.type,
        trust: n.meta.trustScore, created: n.meta.created,
      })),
      edges: [...edges.values()].filter(e => !e.deleted).map(e => e.toJSON()),
    };
  }

  // ─── Conflict resolution: Temporal-Merit ──────────────────────────────────
  function _resolveConflict (local, remote) {
    if (local.meta.trustScore !== remote.meta.trustScore)
      return local.meta.trustScore > remote.meta.trustScore ? local : remote;
    return local.meta.modified > remote.meta.modified ? local : remote;
  }

  // ─── Remote merge ────────────────────────────────────────────────────────
  async function mergeRemoteGraph (remoteNodes, remoteEdges, remoteClock = {}) {
    let merged = 0, conflicts = 0;
    for (const rn of remoteNodes) {
      const local = nodes.get(rn.id);
      if (!local) {
        const node = new GraphNode(rn.type, rn.content, rn.meta);
        node.id   = rn.id;
        node.hash = rn.hash;
        nodes.set(node.id, node);
        merged++;
      } else if (rn.meta.modified > local.meta.modified) {
        const winner = _resolveConflict(local, rn);
        if (winner === rn) { Object.assign(local.meta, rn.meta); local.content = rn.content; conflicts++; }
      }
    }
    for (const re of remoteEdges) {
      if (!edges.has(re.id)) {
        const edge = new GraphEdge(re.sourceId, re.targetId, re.type, re.weight);
        edge.id = re.id;
        edges.set(edge.id, edge);
        merged++;
      }
    }
    _mergeClock(remoteClock);
    await _computeMerkle();
    api.emit('SYS', { msg: `PDMG: merged remote graph — ${merged} new, ${conflicts} conflicts resolved` });
    return { merged, conflicts };
  }

  // ─── Stats ────────────────────────────────────────────────────────────────
  function getStats () {
    return {
      totalNodes  : nodes.size,
      activeNodes : [...nodes.values()].filter(n => !n.deleted).length,
      totalEdges  : edges.size,
      activeEdges : [...edges.values()].filter(e => !e.deleted).length,
      merkleRoot  : merkleRoot?.slice(0, 16),
      vectorClock : { ...vectorClock },
    };
  }

  // ─── Seed with a few initial nodes ───────────────────────────────────────
  (async () => {
    await addNode('FACT',   'System initialized',            { author: 'system',  trustScore: 1.0 });
    await addNode('BELIEF', 'Network topology is stable',    { author: 'analyst', trustScore: 0.9 });
    await addNode('EVENT',  'Extension layer mounted',       { author: 'ext-host',trustScore: 1.0 });
  })();

  api.emit('SYS', { msg: 'PDMG online — knowledge graph active (typed nodes + causal overlay)' });

  // ─── Public API ───────────────────────────────────────────────────────────
  return {
    NodeType, EdgeType,
    addNode, addEdge, updateNode, deleteNode,
    queryNodes,
    getNode  : id => nodes.get(id)?.toJSON() ?? null,
    getEdge  : id => edges.get(id)?.toJSON() ?? null,
    getGraphData,
    getTemporalOverlay,
    getCausalOverlay,
    mergeRemoteGraph,
    getStats,
    getMerkleRoot : () => merkleRoot,
    getVectorClock: () => ({ ...vectorClock }),
  };

}, { version: '1.0.0', description: 'Persistent Distributed Memory Graph — typed nodes/edges, trust scores, temporal overlay, causal chain tracing, Temporal-Merit conflict resolution' });
