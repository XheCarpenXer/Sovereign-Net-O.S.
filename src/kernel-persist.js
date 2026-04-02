"use strict";

/**
 * SOVEREIGN NET OS — Kernel Persistence
 *
 * Serializes kernel snapshots to disk and restores them on boot.
 * The kernel's history log is the source of truth — the snapshot
 * is just a cache of the replayed result.
 *
 * Strategy:
 *   1. On boot:    load snapshot → kernel.restore(snap)
 *   2. On change:  debounced write of kernel.snapshot() to disk
 *   3. On crash:   write a WAL entry before each dispatch (optional, see WAL mode)
 *   4. On quit:    flush final snapshot synchronously
 *
 * File layout (inside Electron userData):
 *   <userData>/kernel/
 *     snapshot.json       — latest full snapshot
 *     snapshot.bak.json   — previous snapshot (for safe swap)
 *     wal.ndjson          — write-ahead log (one JSON event per line)
 */

const fs   = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────

class KernelPersist {
  /**
   * @param {DispatchKernel} kernel   — the kernel instance to persist
   * @param {string}         dataDir  — path to a writable directory (Electron userData)
   * @param {object}         opts
   * @param {number}         opts.debounceMs  — ms to wait before flushing after a change (default 3000)
   * @param {boolean}        opts.wal         — enable write-ahead log for crash recovery (default false)
   * @param {number}         opts.walFlushMs  — ms to rotate WAL into snapshot (default 60000)
   */
  constructor(kernel, dataDir, {
    debounceMs  = 3_000,
    wal         = false,
    walFlushMs  = 60_000,
  } = {}) {
    this.kernel     = kernel;
    this.dir        = path.join(dataDir, "kernel");
    this.snapFile   = path.join(this.dir, "snapshot.json");
    this.backFile   = path.join(this.dir, "snapshot.bak.json");
    this.walFile    = path.join(this.dir, "wal.ndjson");
    this.debounceMs = debounceMs;
    this.walMode    = wal;

    this._timer     = null;
    this._writing   = false;
    this._walStream = null;

    fs.mkdirSync(this.dir, { recursive: true });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // BOOT  — restore snapshot → replay WAL
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Load the last known state into the kernel.
   * Call this once during app startup, before any dispatches.
   * @returns {{ restored: boolean, clock: number, walReplayed: number }}
   */
  restore() {
    let restored   = false;
    let walReplayed = 0;

    // ── 1. Load snapshot ────────────────────────────────────────────────────
    const snap = this._loadSnapshot();
    if (snap) {
      try {
        this.kernel.restore(snap);
        restored = true;
        console.log(`[kernel-persist] Restored snapshot at clock=${this.kernel.clock}`);
      } catch (err) {
        console.error("[kernel-persist] Snapshot restore failed:", err.message);
        // Try backup
        const bak = this._loadFile(this.backFile);
        if (bak) {
          try {
            this.kernel.restore(bak);
            restored = true;
            console.log("[kernel-persist] Restored from backup snapshot");
          } catch (e2) {
            console.error("[kernel-persist] Backup restore also failed:", e2.message);
          }
        }
      }
    }

    // ── 2. Replay WAL on top of snapshot ────────────────────────────────────
    if (this.walMode && fs.existsSync(this.walFile)) {
      walReplayed = this._replayWal();
    }

    // ── 3. Start listening for changes ──────────────────────────────────────
    this._attachListener();

    if (this.walMode) {
      this._openWal();
      // Rotate WAL into snapshot on interval
      setInterval(() => this._rotateWal(), 60_000);
    }

    return { restored, clock: this.kernel.clock, walReplayed };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // FLUSH  — write snapshot immediately
  // ──────────────────────────────────────────────────────────────────────────

  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    this._writeSnapshot();
  }

  /** Call from app.on('before-quit') to guarantee a clean shutdown write */
  flushSync() {
    try {
      const snap = JSON.stringify(this.kernel.snapshot(), null, 0);
      // Safe atomic swap: write to tmp → rename
      const tmp = this.snapFile + ".tmp";
      fs.writeFileSync(tmp, snap, "utf8");
      if (fs.existsSync(this.snapFile)) {
        fs.copyFileSync(this.snapFile, this.backFile);
      }
      fs.renameSync(tmp, this.snapFile);
      console.log(`[kernel-persist] Flushed snapshot (clock=${this.kernel.clock})`);
    } catch (err) {
      console.error("[kernel-persist] flushSync failed:", err.message);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // INTERNALS
  // ──────────────────────────────────────────────────────────────────────────

  _attachListener() {
    this.kernel.on((evt) => {
      // Skip scheduler-only events that don't need to persist immediately
      const skipTypes = new Set(["PEER_REP_DECAY", "KERNEL_RESET_UNITS"]);
      if (skipTypes.has(evt.type)) return;

      if (this.walMode && this._walStream) {
        this._appendWal(evt);
      }
      this._scheduleSave();
    });
  }

  _scheduleSave() {
    if (this._writing) return; // already in-flight
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._writeSnapshot(), this.debounceMs);
  }

  async _writeSnapshot() {
    if (this._writing) return;
    this._writing = true;
    try {
      const snap = JSON.stringify(this.kernel.snapshot(), null, 0);
      const tmp  = this.snapFile + ".tmp";
      fs.writeFileSync(tmp, snap, "utf8");
      if (fs.existsSync(this.snapFile)) {
        fs.copyFileSync(this.snapFile, this.backFile);
      }
      fs.renameSync(tmp, this.snapFile);
    } catch (err) {
      console.error("[kernel-persist] Write failed:", err.message);
    } finally {
      this._writing = false;
    }
  }

  _loadSnapshot() {
    return this._loadFile(this.snapFile);
  }

  _loadFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      console.error(`[kernel-persist] Load failed (${filePath}):`, err.message);
      return null;
    }
  }

  // ── WAL ───────────────────────────────────────────────────────────────────

  _openWal() {
    try {
      this._walStream = fs.createWriteStream(this.walFile, { flags: "a" });
      this._walStream.on("error", (err) => {
        console.error("[kernel-persist] WAL write error:", err.message);
        this._walStream = null;
      });
    } catch (err) {
      console.error("[kernel-persist] WAL open failed:", err.message);
    }
  }

  _appendWal(evt) {
    if (!this._walStream) return;
    try {
      this._walStream.write(JSON.stringify(evt) + "\n");
    } catch (_) {}
  }

  _replayWal() {
    let count = 0;
    try {
      const raw   = fs.readFileSync(this.walFile, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const snapClock = this.kernel.clock;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          // Only replay events that happened after the snapshot's clock
          if (entry.t <= snapClock) continue;
          // Re-dispatch through the kernel
          if (entry.type && !["DISPATCH_REJECTED","DISPATCH_FAILED","DISPATCH_THROTTLED","DISPATCH_UNKNOWN"].includes(entry.type)) {
            this.kernel.dispatch({ ...entry.payload, type: entry.type, origin: "wal-replay" });
            count++;
          }
        } catch (_) {}
      }
      console.log(`[kernel-persist] WAL replay: ${count} events applied`);
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error("[kernel-persist] WAL replay failed:", err.message);
      }
    }
    return count;
  }

  _rotateWal() {
    // Flush current state to snapshot, then truncate WAL
    this._writeSnapshot().then(() => {
      try {
        fs.writeFileSync(this.walFile, "", "utf8"); // truncate
        console.log("[kernel-persist] WAL rotated into snapshot");
      } catch (_) {}
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATION HELPER
// Call this from main.js after kernel + mainWindow are created
// ─────────────────────────────────────────────────────────────────────────────

function attachPersistence(kernel, app, { wal = false } = {}) {
  const persist = new KernelPersist(kernel, app.getPath("userData"), { wal });

  // Restore on boot
  const { restored, clock, walReplayed } = persist.restore();
  console.log(`[kernel-persist] Boot complete — restored=${restored} clock=${clock} wal=${walReplayed}`);

  // Flush on quit (synchronous — must complete before process exits)
  app.on("before-quit", () => persist.flushSync());

  // Expose manual flush for debugging
  kernel._persist = persist;

  return persist;
}

module.exports = { KernelPersist, attachPersistence };
