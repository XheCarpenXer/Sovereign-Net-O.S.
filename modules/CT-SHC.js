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
 * CT-SHC.js — Constant-Time Self-Healing Cryptography (partial)
 * Sovereign Net OS Extension Module
 *
 * Audit ruling — PARTIAL: encrypt/decrypt/sign/hash/keygen are already in
 * the OS. Key gen uses ECDSA-P256 (a step down from the OS's Ed25519 — skip).
 * Three functions are genuinely new and are the only ones included here:
 *
 *   ✓ constantTimeCompare()    — bitwise XOR, prevents timing attacks
 *   ✓ measureTimingBaseline()  — 100-sample SHA-256 mean/stdDev baseline
 *   ✓ runSelfHealingCheck()    — CRITICAL/WARNING health levels with drift detection
 *
 * Usage:
 *   const ctshc = window.__ext.get('ct-shc');
 *   ctshc.constantTimeCompare(a, b);           // → boolean
 *   const baseline = await ctshc.measureTimingBaseline();
 *   const health   = await ctshc.runSelfHealingCheck();
 *   // health.ok, health.issues[{ type:'CRITICAL'|'WARNING', msg }]
 */

window.__ext.register('ct-shc', function (api) {
  'use strict';

  // ─── State ────────────────────────────────────────────────────────────────
  let _timingBaseline = null;

  // ─── constantTimeCompare ──────────────────────────────────────────────────
  /**
   * Compare two Uint8Arrays in constant time (bitwise XOR).
   * Prevents timing side-channel attacks on secret comparison.
   * Returns false immediately if lengths differ (length itself is not secret here).
   * @param {Uint8Array} a
   * @param {Uint8Array} b
   * @returns {boolean}
   */
  function constantTimeCompare (a, b) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array))
      throw new TypeError('CT-SHC: constantTimeCompare requires two Uint8Arrays');
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
    return result === 0;
  }

  // ─── measureTimingBaseline ────────────────────────────────────────────────
  /**
   * Collect 100 SHA-256 timing samples and compute mean + stdDev.
   * Stores result as the module's reference baseline for drift detection.
   * @returns {Promise<{ mean: number, stdDev: number, samples: number[] }>}
   */
  async function measureTimingBaseline () {
    const samples = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      await crypto.subtle.digest('SHA-256', new Uint8Array(32));
      samples.push(performance.now() - t0);
    }
    const mean    = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((acc, s) => acc + Math.pow(s - mean, 2), 0) / samples.length;
    const result   = { mean, stdDev: Math.sqrt(variance), samples };
    _timingBaseline = result;
    return result;
  }

  // ─── runSelfHealingCheck ──────────────────────────────────────────────────
  /**
   * Run all self-healing checks. Returns a health object:
   *   { ok: boolean, issues: [{ type: 'CRITICAL'|'WARNING', msg: string }], checks, lastCheck }
   *
   * Checks performed:
   *   1. Web Crypto API availability       → CRITICAL if absent
   *   2. Timing drift vs baseline          → WARNING if drift > 3σ
   *   3. Randomness quality (10 samples)   → CRITICAL if duplicate detected
   *   4. Symmetric key generation          → WARNING if fails
   *
   * @returns {Promise<HealthStatus>}
   */
  async function runSelfHealingCheck () {
    const issues = [];
    const checks = {
      cryptoAvailable  : false,
      timingStable     : false,
      randomnessHealthy: false,
      keyGenWorking    : false,
    };

    // 1 — Web Crypto
    try {
      checks.cryptoAvailable = typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
      if (!checks.cryptoAvailable)
        issues.push({ type: 'CRITICAL', msg: 'Web Crypto API not available' });
    } catch (e) {
      issues.push({ type: 'CRITICAL', msg: `Web Crypto check failed: ${e.message}` });
    }

    // 2 — Timing drift
    // FIX: Save the old baseline BEFORE calling measureTimingBaseline(), which
    // overwrites _timingBaseline. Without this the comparison (_timingBaseline !== current)
    // was always false (same object reference), so drift was never detected.
    try {
      const previousBaseline = _timingBaseline;
      const current = await measureTimingBaseline();
      if (previousBaseline && previousBaseline !== current) {
        const drift     = Math.abs(current.mean - previousBaseline.mean);
        const threshold = previousBaseline.stdDev * 3;
        checks.timingStable = drift < threshold;
        if (!checks.timingStable)
          issues.push({ type: 'WARNING', msg: `Timing drift: ${drift.toFixed(3)} ms (σ×3 = ${threshold.toFixed(3)} ms)` });
      } else {
        checks.timingStable = true;
      }
    } catch (e) {
      issues.push({ type: 'WARNING', msg: `Timing check failed: ${e.message}` });
    }

    // 3 — Randomness
    try {
      const seen = new Set();
      let ok = true;
      for (let i = 0; i < 10; i++) {
        const buf = new Uint8Array(32);
        crypto.getRandomValues(buf);
        const hex = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
        if (seen.has(hex)) { ok = false; break; }
        seen.add(hex);
      }
      checks.randomnessHealthy = ok;
      if (!ok) issues.push({ type: 'CRITICAL', msg: 'RNG may be compromised — duplicate random output detected' });
    } catch (e) {
      issues.push({ type: 'WARNING', msg: `Randomness check failed: ${e.message}` });
    }

    // 4 — Key gen (AES-GCM only — we do NOT use P-256 keygen per audit ruling)
    try {
      const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      checks.keyGenWorking = !!k;
    } catch (e) {
      issues.push({ type: 'WARNING', msg: `Key generation check failed: ${e.message}` });
    }

    const health = {
      ok      : issues.filter(i => i.type === 'CRITICAL').length === 0,
      issues,
      checks,
      lastCheck: Date.now(),
    };

    api.emit('SYS', { msg: `CT-SHC health: ${health.ok ? 'OK' : 'ISSUES — ' + issues.map(i => i.msg).join('; ')}` });
    return health;
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  // Establish baseline on load, then run full check
  measureTimingBaseline().then(() => runSelfHealingCheck());
  // Re-check every 60 s
  setInterval(runSelfHealingCheck, 60_000);

  api.emit('SYS', { msg: 'CT-SHC online — constant-time compare + self-healing checks active' });

  // ─── Public API ───────────────────────────────────────────────────────────
  return {
    constantTimeCompare,
    measureTimingBaseline,
    runSelfHealingCheck,
    getBaseline: () => _timingBaseline ? { ..._timingBaseline, samples: undefined } : null,
  };

}, { version: '1.0.0', description: 'Constant-Time Self-Healing Cryptography (partial) — constantTimeCompare, measureTimingBaseline, runSelfHealingCheck' });
