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
// OOM guard — reject logs that would materialise too many events in memory.
// Tune this constant for your heap budget; 50 000 is a safe default for most
// Electron main-process workloads (~50 MB at ~1 KB per entry).
const MAX_REPLAY_EVENTS = 50_000;

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
    // ── OOM guard ─────────────────────────────────────────────────────────────
    if (!Array.isArray(history)) {
      throw new TypeError("replay(): history must be an Array");
    }
    if (history.length > MAX_REPLAY_EVENTS) {
      throw new RangeError(
        `replay(): history length ${history.length} exceeds MAX_REPLAY_EVENTS (${MAX_REPLAY_EVENTS}). ` +
        "Trim the log before replaying or raise the constant if your heap supports it."
      );
    }

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

      // ── Entry structure validation ─────────────────────────────────────────
      const validationError = this._validateEntry(entry);
      if (validationError) {
        errors.push({ entry, error: validationError });
        if (strict) throw new Error(`Invalid entry at t=${entry.t}: ${validationError}`);
        skipped++;
        continue;
      }

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
  // VALIDATE ENTRY  — structural check before every dispatch attempt
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Validate a single history entry's structure.
   * Returns an error string on failure, or null if the entry is well-formed.
   *
   * Rules enforced:
   *   • entry must be a non-null, non-array object
   *   • entry.t    — required, finite number (clock tick)
   *   • entry.type — required, non-empty string
   *   • entry.payload — optional; when present must be a plain object
   *     (not an array, not a primitive) so the dispatcher can spread it safely
   *     The nested double-wrap shape { payload: { payload: ... } } is also
   *     checked: the inner slot must likewise be a plain object if present.
   *
   * @param {*} entry
   * @returns {string|null}  error message, or null when valid
   */
  _validateEntry(entry) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return "entry must be a non-null, non-array object";
    }

    // clock tick
    if (typeof entry.t !== "number" || !Number.isFinite(entry.t)) {
      return `entry.t must be a finite number (got ${JSON.stringify(entry.t)})`;
    }

    // event type
    if (typeof entry.type !== "string" || entry.type.trim() === "") {
      return `entry.type must be a non-empty string (got ${JSON.stringify(entry.type)})`;
    }

    // payload — absence is fine (treated as {}); presence must be a plain object
    if (entry.payload !== undefined && entry.payload !== null) {
      if (typeof entry.payload !== "object" || Array.isArray(entry.payload)) {
        return (
          `entry.payload must be a plain object when provided ` +
          `(got ${Array.isArray(entry.payload) ? "Array" : typeof entry.payload})`
        );
      }
      // Double-wrapped shape: { payload: { payload: <inner> } }
      // The outer unwrapping in replay() is fine, but the inner slot must also
      // be a plain object if it exists.
      if (
        entry.payload.payload !== undefined &&
        entry.payload.payload !== null &&
        (typeof entry.payload.payload !== "object" || Array.isArray(entry.payload.payload))
      ) {
        return (
          `entry.payload.payload must be a plain object when present ` +
          `(got ${Array.isArray(entry.payload.payload) ? "Array" : typeof entry.payload.payload})`
        );
      }
    }

    return null;
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

/**
 * @param {DispatchKernel} kernel
 * @param {Electron.IpcMain} ipcMain
 * @param {Electron.BrowserWindow|null} [mainWindow]  — optional; enables push divergence alerts
 */
function attachReplayBridge(kernel, ipcMain, mainWindow = null) {
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

  // ── Divergence: compare this node's history against a peer's log ──────────
  // The renderer calls this after receiving a peer's event log via sync.
  // If divergence is detected the result is returned AND pushed as a
  // kernel:divergence IPC event so any open UI panel can surface a banner.
  ipcMain.handle("kernel:compare", async (_event, { peerHistory, peerId }) => {
    try {
      const localHistory = kernel.replay();
      const result = replayer.compare(localHistory, peerHistory);

      if (result.diverged) {
        console.warn(
          `[kernel-replay] Divergence detected vs peer ${peerId ?? "unknown"}: ` +
          `${result.diffs.length} diff(s)`
        );
        // Push to renderer so the UI can display a banner
        mainWindow?.webContents?.send("kernel:divergence", {
          peerId:    peerId ?? "unknown",
          diffs:     result.diffs,
          clockA:    result.clockA,
          clockB:    result.clockB,
          detectedAt: Date.now(),
        });
      }

      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Self-consistency check: replay current history and detect internal drift
  // Called periodically (or on demand). Pushes kernel:divergence if the
  // replayed snapshot disagrees with the live kernel state.
  ipcMain.handle("kernel:selfcheck", async () => {
    try {
      const history  = kernel.replay();
      const { kernel: replayedK } = replayer.replay(history);
      const result = replayer.compare(history, replayedK.replay());

      if (result.diverged) {
        mainWindow?.webContents?.send("kernel:divergence", {
          peerId:    "self",
          diffs:     result.diffs,
          clockA:    result.clockA,
          clockB:    result.clockB,
          detectedAt: Date.now(),
        });
      }

      return { ok: true, diverged: result.diverged, diffs: result.diffs };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  return replayer;
}

module.exports = { KernelReplayer, attachReplayBridge };
