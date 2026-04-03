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
 * NPS.js — Nano-Pulse Scheduler
 * Sovereign Net OS Extension Module
 *
 * Fills gap: the OS runs everything on scattered setIntervals with no
 * coordination. NPS provides a unified cooperative queue across 5 priority
 * levels with credit-based yielding and starvation detection.
 * Also the correct hook for spec sheet 1's battery throttle (item 11).
 *
 * What this adds:
 *   - Priority queue (UI > Agent > Memory > Network > Background)
 *   - Credit-based yielding — high-priority work can't starve low-priority forever
 *   - Starvation detection with forced yield
 *   - requestIdleCallback integration
 *   - Heartbeat data for monitoring
 *
 * Usage:
 *   const nps = window.__ext.get('nps');
 *   const id  = nps.schedule(nps.PulseType.AGENT, async () => { ... }, { name: 'my-task' });
 *   nps.cancel(id);
 *   nps.getHeartbeat();   // per-lane queue depths, credits, latency
 */

window.__ext.register('nps', function (api) {
  'use strict';

  // ─── Configuration ────────────────────────────────────────────────────────
  const config = {
    maxPulseTime       : 10,    // ms budget per scheduler tick
    starvationThreshold: 500,   // ms before starvation boost kicks in
    creditBudget       : 100,   // credits replenished each tick
    yieldAfterCredits  : 20,    // force yield after N tasks in one tick
    creditReplenish    : 5,     // credits added back per tick
  };

  // ─── Priority lanes ───────────────────────────────────────────────────────
  const PulseType = Object.freeze({
    UI        : 'ui',
    AGENT     : 'agent',
    MEMORY    : 'memory',
    NETWORK   : 'network',
    BACKGROUND: 'background',
  });

  const PulsePriority = Object.freeze({
    ui: 100, agent: 80, memory: 60, network: 50, background: 20,
  });

  // ─── State ────────────────────────────────────────────────────────────────
  let running = false;
  const queues       = new Map();
  const credits      = new Map();
  const lastPulse    = new Map();
  let   pulseHistory = [];
  const stats = {
    totalPulses: 0, pulsesPerType: {}, averageLatency: 0,
    starvationEvents: 0, forcedYields: 0, lastFrameTime: 0,
  };

  Object.values(PulseType).forEach(t => {
    queues.set(t, []);
    credits.set(t, config.creditBudget);
    lastPulse.set(t, performance.now());
    stats.pulsesPerType[t] = 0;
  });

  // ─── Task ─────────────────────────────────────────────────────────────────
  class PulseTask {
    constructor (type, callback, meta = {}) {
      this.id       = crypto.randomUUID();
      this.type     = type;
      this.callback = callback;
      this.meta     = { ...meta, created: performance.now() };
      this.priority = PulsePriority[type] ?? 0;
    }
  }

  // ─── Schedule / cancel ────────────────────────────────────────────────────
  function schedule (type, callback, meta = {}) {
    const queue = queues.get(type);
    if (!queue) throw new Error(`NPS: unknown pulse type "${type}"`);
    const task = new PulseTask(type, callback, meta);
    queue.push(task);
    return task.id;
  }

  function cancel (taskId) {
    for (const [type, queue] of queues) {
      const i = queue.findIndex(t => t.id === taskId);
      if (i !== -1) { queue.splice(i, 1); return true; }
    }
    return false;
  }

  // ─── Pick next task ───────────────────────────────────────────────────────
  function _nextTask () {
    let bestTask = null, bestType = null, bestPri = -1;
    for (const [type, queue] of queues) {
      if (!queue.length) continue;
      const sinceLastPulse = performance.now() - lastPulse.get(type);
      const starvBoost     = sinceLastPulse > config.starvationThreshold ? 50 : 0;
      if (starvBoost) stats.starvationEvents++;
      const eff = queue[0].priority + starvBoost;
      if (eff > bestPri && credits.get(type) > 0) { bestTask = queue[0]; bestType = type; bestPri = eff; }
    }
    return { task: bestTask, type: bestType };
  }

  // ─── Execute one task ─────────────────────────────────────────────────────
  async function _execute (task, type) {
    const t0 = performance.now();
    try {
      await task.callback();
    } catch (e) {
      api.emit('SYS', { msg: `NPS: task error in ${type} — ${e.message}` });
    }
    const dur = performance.now() - t0;
    stats.totalPulses++;
    stats.pulsesPerType[type]++;
    stats.averageLatency = stats.averageLatency * 0.9 + dur * 0.1;
    lastPulse.set(type, performance.now());
    credits.set(type, Math.max(0, credits.get(type) - Math.ceil(dur)));
    pulseHistory.push({ id: task.id, type, duration: dur, timestamp: t0 });
    if (pulseHistory.length > 100) pulseHistory = pulseHistory.slice(-100);
  }

  // ─── Scheduler tick ───────────────────────────────────────────────────────
  async function _tick () {
    if (!running) return;
    const t0     = performance.now();
    let   worked = 0;

    while (running) {
      if (performance.now() - t0 > config.maxPulseTime) { stats.forcedYields++; break; }
      const { task, type } = _nextTask();
      if (!task) break;
      queues.get(type).shift();
      await _execute(task, type);
      if (++worked >= config.yieldAfterCredits) { stats.forcedYields++; break; }
    }

    stats.lastFrameTime = performance.now() - t0;

    // Replenish credits
    credits.forEach((c, t) => credits.set(t, Math.min(config.creditBudget, c + config.creditReplenish)));

    // Schedule next tick via requestIdleCallback if available
    if (running) {
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => setTimeout(_tick, 0), { timeout: 50 });
      } else {
        setTimeout(_tick, 16);
      }
    }
  }

  // ─── Start / stop ─────────────────────────────────────────────────────────
  function start () {
    if (running) return;
    running = true;
    _tick();
    api.emit('SYS', { msg: 'NPS: scheduler started' });
  }

  function stop () {
    running = false;
    api.emit('SYS', { msg: 'NPS: scheduler stopped' });
  }

  // ─── Heartbeat ────────────────────────────────────────────────────────────
  function getHeartbeat () {
    const now = performance.now();
    return Object.values(PulseType).map(type => ({
      type,
      queueLength       : queues.get(type)?.length ?? 0,
      credits           : credits.get(type) ?? 0,
      timeSinceLastPulse: now - (lastPulse.get(type) ?? now),
      totalPulses       : stats.pulsesPerType[type] ?? 0,
      priority          : PulsePriority[type],
    }));
  }

  // Auto-start
  start();
  api.emit('SYS', { msg: 'NPS online — cooperative scheduler running (5 lanes)' });

  // ─── Public API ───────────────────────────────────────────────────────────
  return {
    PulseType,
    PulsePriority,
    schedule,
    cancel,
    start,
    stop,
    getHeartbeat,
    getStats   : () => ({
      ...stats,
      running,
      queueSizes: Object.fromEntries([...queues].map(([t, q]) => [t, q.length])),
      credits   : Object.fromEntries(credits),
    }),
    getHistory : () => [...pulseHistory],
    isRunning  : () => running,
  };

}, { version: '1.0.0', description: 'Nano-Pulse Scheduler — 5-lane priority queue, credit-based yielding, starvation detection, requestIdleCallback' });
