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
 * DCP.js — Delegated Cognitive Permissions
 * Sovereign Net OS Extension Module
 *
 * Fills gap: OS has zero permission governance — agents have unconstrained
 * access to everything. DCP is the only module with no overlap with either
 * spec sheet.
 *
 * What this adds:
 *   - MindToken: scoped, time-limited, revocable access grants per agent
 *   - 8 permission types
 *   - Temporal duration enforcement with automatic GC
 *   - Cognitive impact score (0.0–1.0) per agent
 *   - Delegation graph (who delegated what to whom)
 *   - simulateDelegation() — dry-run without committing
 *   - Full audit log
 *
 * Usage:
 *   const dcp = window.__ext.get('dcp');
 *   const tok = dcp.grantToken('agent-alice', ['READ_MEMORY','INFERENCE'], dcp.Duration.ONE_DAY);
 *   dcp.hasPermission('agent-alice', 'INFERENCE');   // → true
 *   dcp.revokeToken(tok.id);
 *   dcp.simulateDelegation('agent-alice', ['PULSE_EXECUTION'], dcp.Duration.ONE_HOUR);
 */

window.__ext.register('dcp', function (api) {
  'use strict';

  // ─── Permission types ─────────────────────────────────────────────────────
  const PermissionType = Object.freeze({
    READ_MEMORY      : 'read_memory',
    WRITE_EPISODIC   : 'write_episodic',
    WRITE_LONGTERM   : 'write_longterm',
    PULSE_EXECUTION  : 'pulse_execution',
    NETWORK_ACCESS   : 'network_access',
    VAULT_READ       : 'vault_read',
    VAULT_WRITE      : 'vault_write',
    AGENT_CONTROL    : 'agent_control',
  });

  // Cognitive impact weights per permission
  const _IMPACT = {
    read_memory: 0.2, write_episodic: 0.4, write_longterm: 0.8,
    pulse_execution: 0.5, network_access: 0.3,
    vault_read: 0.4, vault_write: 0.9, agent_control: 1.0,
  };

  // ─── Presets ──────────────────────────────────────────────────────────────
  const Presets = Object.freeze({
    READ_ONLY       : { name: 'Read-Only Memory Access',    permissions: ['read_memory'] },
    EPISODIC_WRITER : { name: 'Episodic Memory Writer',     permissions: ['read_memory', 'write_episodic'] },
    FULL_MEMORY     : { name: 'Full Memory Access',         permissions: ['read_memory', 'write_episodic', 'write_longterm'] },
    PULSE_EXECUTOR  : { name: 'Pulse Executor',             permissions: ['read_memory', 'pulse_execution'] },
    NETWORK_OPERATOR: { name: 'Network Operator',           permissions: ['read_memory', 'network_access'] },
  });

  // ─── Duration helpers (ms) ────────────────────────────────────────────────
  const Duration = Object.freeze({
    ONE_HOUR  : 3_600_000,
    SIX_HOURS : 21_600_000,
    ONE_DAY   : 86_400_000,
    ONE_WEEK  : 604_800_000,
    MANUAL    : -1,          // Requires explicit revocation
  });

  // ─── State ────────────────────────────────────────────────────────────────
  const _tokens      = new Map();   // tokenId → MindToken
  const _delegations = new Map();   // agentId → Set<tokenId>
  let   _auditLog    = [];

  // ─── MindToken ────────────────────────────────────────────────────────────
  class MindToken {
    constructor (grantedTo, permissions, duration, meta = {}) {
      this.id          = crypto.randomUUID();
      this.grantedTo   = grantedTo;
      this.permissions = [...permissions];
      this.grantedBy   = meta.grantedBy ?? 'root';
      this.created     = Date.now();
      this.expires     = duration === Duration.MANUAL ? null : Date.now() + duration;
      this.revoked     = false;
      this.revokedAt   = null;
      this.usageCount  = 0;
      this.lastUsed    = null;
      this.cognitiveImpact = this._calcImpact();
    }
    _calcImpact () {
      const sum = this.permissions.reduce((s, p) => s + (_IMPACT[p] ?? 0.05), 0);
      return Math.min(1, sum / Math.max(1, this.permissions.length));
    }
    isValid () {
      if (this.revoked) return false;
      if (this.expires !== null && Date.now() > this.expires) return false;
      return true;
    }
    use () {
      if (!this.isValid()) return false;
      this.usageCount++;
      this.lastUsed = Date.now();
      return true;
    }
    revoke () {
      this.revoked   = true;
      this.revokedAt = Date.now();
    }
    toJSON () {
      return {
        id: this.id, grantedTo: this.grantedTo, permissions: this.permissions,
        grantedBy: this.grantedBy, created: this.created, expires: this.expires,
        isValid: this.isValid(), revoked: this.revoked, usageCount: this.usageCount,
        lastUsed: this.lastUsed, cognitiveImpact: this.cognitiveImpact,
        timeRemaining: this.expires ? Math.max(0, this.expires - Date.now()) : null,
      };
    }
  }

  // ─── Audit ────────────────────────────────────────────────────────────────
  function _log (action, details) {
    _auditLog.push({ id: crypto.randomUUID(), action, details, timestamp: Date.now() });
    if (_auditLog.length > 500) _auditLog = _auditLog.slice(-500);
  }

  // ─── Grant ────────────────────────────────────────────────────────────────
  function grantToken (grantedTo, permissions, duration, meta = {}) {
    const token = new MindToken(grantedTo, permissions, duration, meta);
    _tokens.set(token.id, token);
    if (!_delegations.has(grantedTo)) _delegations.set(grantedTo, new Set());
    _delegations.get(grantedTo).add(token.id);
    _log('GRANT', { tokenId: token.id, grantedTo, permissions, duration });
    api.emit('SYS', { msg: `DCP: granted [${permissions.join(',')}] → ${grantedTo}` });
    return token.toJSON();
  }

  function grantPreset (grantedTo, presetName, duration) {
    const preset = Presets[presetName];
    if (!preset) throw new Error(`DCP: unknown preset "${presetName}"`);
    return grantToken(grantedTo, preset.permissions, duration, { presetName });
  }

  // ─── Revoke ───────────────────────────────────────────────────────────────
  function revokeToken (tokenId) {
    const token = _tokens.get(tokenId);
    if (!token) return false;
    token.revoke();
    _log('REVOKE', { tokenId, grantedTo: token.grantedTo });
    api.emit('SYS', { msg: `DCP: revoked token ${tokenId}` });
    return true;
  }

  function revokeAll (grantedTo) {
    let count = 0;
    for (const id of (_delegations.get(grantedTo) ?? [])) {
      const t = _tokens.get(id);
      if (t && !t.revoked) { t.revoke(); count++; }
    }
    _log('REVOKE_ALL', { grantedTo, count });
    api.emit('SYS', { msg: `DCP: revoked all (${count}) tokens for ${grantedTo}` });
    return count;
  }

  // ─── Check ────────────────────────────────────────────────────────────────
  function hasPermission (entity, permission) {
    for (const id of (_delegations.get(entity) ?? [])) {
      const t = _tokens.get(id);
      if (t && t.isValid() && t.permissions.includes(permission)) {
        t.use();
        return true;
      }
    }
    return false;
  }

  // ─── Delegation graph ─────────────────────────────────────────────────────
  function getDelegationGraph () {
    const nodes = [{ id: 'root', type: 'root', label: 'Human Controller' }];
    const links = [];
    _delegations.forEach((ids, agent) => {
      const active = [...ids].map(id => _tokens.get(id)).filter(t => t?.isValid());
      if (!active.length) return;
      nodes.push({
        id: agent, type: 'agent', label: agent,
        tokenCount: active.length,
        cognitiveImpact: active.reduce((s, t) => s + t.cognitiveImpact, 0) / active.length,
      });
      links.push({
        source: active[0].grantedBy ?? 'root', target: agent,
        tokenCount: active.length,
        permissions: [...new Set(active.flatMap(t => t.permissions))],
      });
    });
    return { nodes, links };
  }

  // ─── Simulate ─────────────────────────────────────────────────────────────
  function simulateDelegation (grantedTo, permissions, duration = Duration.ONE_DAY) {
    const already      = getActiveTokens(grantedTo).flatMap(t => t.permissions);
    const wouldGrant   = permissions.filter(p => !already.includes(p));
    const wouldConflict = permissions.filter(p => already.includes(p));
    const delta        = wouldGrant.reduce((s, p) => s + (_IMPACT[p] ?? 0.05), 0);
    const newImpact    = Math.min(1, (impactScore(grantedTo) + delta));
    return {
      wouldGrant, wouldConflict, newImpact,
      riskLevel: newImpact > 0.7 ? 'high' : newImpact > 0.4 ? 'medium' : 'low',
    };
  }

  // ─── Stats / helpers ──────────────────────────────────────────────────────
  function getActiveTokens (grantedTo) {
    return [...(_delegations.get(grantedTo) ?? [])]
      .map(id => _tokens.get(id)).filter(t => t?.isValid()).map(t => t.toJSON());
  }

  function impactScore (grantedTo) {
    const active = [...(_delegations.get(grantedTo) ?? [])]
      .map(id => _tokens.get(id)).filter(t => t?.isValid());
    const sum = active.reduce((s, t) => s + t.cognitiveImpact, 0);
    return Math.min(1, sum);
  }

  function getStats () {
    const active  = [..._tokens.values()].filter(t => t.isValid());
    const revoked = [..._tokens.values()].filter(t => t.revoked);
    return {
      totalTokens: _tokens.size, activeTokens: active.length,
      revokedTokens: revoked.length, uniqueEntities: _delegations.size,
      totalUsage: active.reduce((s, t) => s + t.usageCount, 0),
      avgCognitiveImpact: active.length
        ? active.reduce((s, t) => s + t.cognitiveImpact, 0) / active.length : 0,
    };
  }

  function cleanupExpired () {
    let count = 0;
    _tokens.forEach(t => { if (!t.revoked && t.expires !== null && Date.now() > t.expires) { t.revoke(); count++; } });
    if (count) _log('GC', { expiredCount: count });
    return count;
  }

  // Periodic GC
  setInterval(cleanupExpired, 60_000);

  api.emit('SYS', { msg: 'DCP online — cognitive permission governance active' });

  // ─── Public API ───────────────────────────────────────────────────────────
  return {
    PermissionType, Presets, Duration,
    grantToken, grantPreset, revokeToken, revokeAll,
    hasPermission,
    getActiveTokens,
    getToken     : id => _tokens.get(id)?.toJSON() ?? null,
    getTokens    : ()  => [..._tokens.values()].map(t => t.toJSON()),
    getDelegationGraph,
    simulateDelegation,
    impactScore,
    getStats,
    getAuditLog  : () => [..._auditLog].slice(-100),
    cleanupExpired,
  };

}, { version: '1.0.0', description: 'Delegated Cognitive Permissions — MindToken grant/revoke, 8 permission types, cognitive impact score, delegation graph' });
