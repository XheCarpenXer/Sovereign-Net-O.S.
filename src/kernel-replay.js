"use strict";

/**
 * SOVEREIGN NET OS — Kernel Replay Engine
 *
 * True event sourcing: state = f(event log).
 * Given a history array, this rebuilds the kernel from zero
 * without any snapshot dependency.
 *
 * Use cases:
 *   1. Debug / audit: replay a peer's event log to verify their state
 *   2. Divergence detection: compare two nodes' replays
 *   3. Time-travel: replay up to clock N to inspect past state
 *   4. Migration: replay on a new kernel version to upgrade state shape
 *   5. Proof: prove a state claim by sharing a replayable log
 */

const { DispatchKernel } = require("./kernel");

// ─────────────────────────────────────────────────────────────────────────────

class KernelReplayer {
  /**
   * @param {object} opts — same options as DispatchKernel constructor
   */
  constructor(opts = {}) {
    this._kernelOpts = opts;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // REPLAY  — apply a history log to a fresh kernel
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Replay a full history log and return the reconstructed kernel.
   *
   * @param {Array}   history       — kernel.replay() output (array of {t, type, payload})
   * @param {object}  [opts]
   * @param {number}  [opts.toClockT]   — stop at this clock tick (inclusive). Default: replay all.
   * @param {boolean} [opts.strict]     — throw on any failed dispatch instead of skipping. Default: false.
   * @returns {{ kernel: DispatchKernel, applied: number, skipped: number, errors: Array }}
   */
  replay(history, { toClockT = Infinity, strict = false } = {}) {
    const k = new DispatchKernel(this._kernelOpts);

    // Register same custom handlers if needed — subclass and override _configure(k)
    this._configure(k);

    let applied = 0;
    let skipped = 0;
    const errors = [];

    // Filter to only dispatchable entries (skip meta-events)
    const skip = new Set([
      "DISPATCH_REJECTED", "DISPATCH_FAILED", "DISPATCH_THROTTLED",
      "DISPATCH_UNKNOWN", "observe",
    ]);

    for (const entry of history) {
      if (entry.t > toClockT) break;
      if (skip.has(entry.type)) { skipped++; continue; }

      try {
        const result = k.dispatch({
          type:    entry.type,
          payload: entry.payload?.payload ?? entry.payload ?? {},
          origin:  "replay",
        });

        if (!result.ok) {
          errors.push({ entry, error: result.error });
          if (strict) throw new Error(`Replay failed at t=${entry.t}: ${result.error}`);
          skipped++;
        } else {
          applied++;
        }
      } catch (err) {
        errors.push({ entry, error: err.message });
        if (strict) throw err;
        skipped++;
      }
    }

    return { kernel: k, applied, skipped, errors };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // COMPARE  — detect divergence between two histories
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Replay two histories and compare their resulting states.
   * Returns a diff of any diverged keys.
   *
   * @param {Array} historyA
   * @param {Array} historyB
   * @returns {{ diverged: boolean, diffs: Array, stateA: object, stateB: object }}
   */
  compare(historyA, historyB) {
    const { kernel: kA } = this.replay(historyA);
    const { kernel: kB } = this.replay(historyB);

    const snapA = kA.snapshot();
    const snapB = kB.snapshot();

    const diffs = [];

    // Compare SharedState keys
    const keysA = new Set(Object.keys(snapA.state));
    const keysB = new Set(Object.keys(snapB.state));
    const allKeys = new Set([...keysA, ...keysB]);

    for (const key of allKeys) {
      const valA = JSON.stringify(snapA.state[key] ?? null);
      const valB = JSON.stringify(snapB.state[key] ?? null);
      if (valA !== valB) {
        diffs.push({ scope: "state", key, a: snapA.state[key], b: snapB.state[key] });
      }
    }

    // Compare DAG node sets
    const dagNodesA = new Set(Object.keys(snapA.dag?.nodes ?? {}));
    const dagNodesB = new Set(Object.keys(snapB.dag?.nodes ?? {}));
    for (const id of dagNodesA) {
      if (!dagNodesB.has(id)) diffs.push({ scope: "dag", key: id, a: "present", b: "missing" });
    }
    for (const id of dagNodesB) {
      if (!dagNodesA.has(id)) diffs.push({ scope: "dag", key: id, a: "missing", b: "present" });
    }

    return {
      diverged: diffs.length > 0,
      diffs,
      clockA: snapA.clock,
      clockB: snapB.clock,
      stateA: snapA.state,
      stateB: snapB.state,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TIME-TRAVEL  — get state at a specific clock tick
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * @param {Array}  history
   * @param {number} clockT   — the clock tick to inspect
   * @returns {object}        — kernel snapshot at that point in time
   */
  at(history, clockT) {
    const { kernel } = this.replay(history, { toClockT: clockT });
    return kernel.snapshot();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // VERIFY  — prove a state claim from a log
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Verify that a given state key had a specific value at clock T.
   * This is the basis of a "state proof" — share the log, others can verify.
   *
   * @param {Array}   history
   * @param {string}  stateKey
   * @param {*}       expectedValue
   * @param {number}  [atClock]     — defaults to end of log
   * @returns {{ valid: boolean, actual: *, clock: number }}
   */
  verify(history, stateKey, expectedValue, atClock = Infinity) {
    const snap   = this.at(history, atClock);
    const actual = snap.state[stateKey];
    return {
      valid:  JSON.stringify(actual) === JSON.stringify(expectedValue),
      actual,
      clock:  snap.clock,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TRIM  — remove redundant history before a checkpoint
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Trim history to only events after clockT.
   * The current snapshot serves as the new baseline.
   * This keeps history logs from growing without bound.
   *
   * Returns the trimmed log — the caller should update kernel.history.
   *
   * @param {Array}  history
   * @param {number} afterClock
   * @returns {Array}
   */
  trim(history, afterClock) {
    return history.filter(entry => entry.t > afterClock);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MERGE  — combine two diverged event logs (CRDT-style)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Merge two event logs from different nodes.
   * Events are sorted by (t, id) — ties broken by event ID for determinism.
   * Duplicate events (same id) are deduplicated.
   *
   * @param {Array} logA
   * @param {Array} logB
   * @returns {Array} merged, sorted log
   */
  merge(logA, logB) {
    const seen = new Set();
    const combined = [];

    for (const entry of [...logA, ...logB]) {
      const key = entry.id ?? `${entry.t}:${entry.type}:${JSON.stringify(entry.payload)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      combined.push(entry);
    }

    // Sort by clock tick, then by event id for ties
    combined.sort((a, b) => {
      if (a.t !== b.t) return a.t - b.t;
      return (a.id ?? "").localeCompare(b.id ?? "");
    });

    return combined;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Override in subclasses to register custom handlers on the replay kernel
  // ──────────────────────────────────────────────────────────────────────────

  _configure(_kernel) {
    // no-op base; subclasses add custom handlers here
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC INTEGRATION
// Expose replay tools through kernel:replay IPC channel
// ─────────────────────────────────────────────────────────────────────────────

function attachReplayBridge(kernel, ipcMain) {
  const replayer = new KernelReplayer();

  // Full replay from stored history
  ipcMain.handle("kernel:replay", async (_event, { toClockT, strict } = {}) => {
    try {
      const history = kernel.replay();
      const result  = replayer.replay(history, { toClockT, strict });
      return {
        ok:      true,
        applied: result.applied,
        skipped: result.skipped,
        errors:  result.errors,
        snapshot: result.kernel.snapshot(),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Time-travel: state at clock T
  ipcMain.handle("kernel:at", async (_event, { clockT }) => {
    try {
      const snap = replayer.at(kernel.replay(), clockT);
      return { ok: true, result: snap };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Verify a state claim
  ipcMain.handle("kernel:verify", async (_event, { stateKey, expectedValue, atClock }) => {
    try {
      return { ok: true, result: replayer.verify(kernel.replay(), stateKey, expectedValue, atClock) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  return replayer;
}

module.exports = { KernelReplayer, attachReplayBridge };
