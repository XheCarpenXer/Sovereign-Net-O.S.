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
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FNV-1a 32-bit — fast, zero-dependency, deterministic.
 * Used to checksum each WAL line so corrupted or tampered entries are
 * detected and skipped during crash-recovery replay.
 */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Maximum WAL entries before a forced mid-session rotation is triggered. */
const WAL_MAX_DEPTH = 2_000;

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
    this._restoreErrors = [];

    // ── 1. Load snapshot ────────────────────────────────────────────────────
    const snap = this._loadSnapshot();
    if (snap) {
      try {
        this.kernel.restore(snap);
        restored = true;
        console.log(`[kernel-persist] Restored snapshot at clock=${this.kernel.clock}`);
      } catch (err) {
        console.error("[kernel-persist] Snapshot restore failed:", err.message);
        this._restoreErrors.push({ file: "snapshot", error: err.message });
        // Try backup
        const bak = this._loadFile(this.backFile);
        if (bak) {
          try {
            this.kernel.restore(bak);
            restored = true;
            console.log("[kernel-persist] Restored from backup snapshot");
          } catch (e2) {
            console.error("[kernel-persist] Backup restore also failed:", e2.message);
            this._restoreErrors.push({ file: "snapshot.bak", error: e2.message });
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

  // ──────────────────────────────────────────────────────────────────────────
  // HEALTH  — observable persist status for UI status panel
  // ──────────────────────────────────────────────────────────────────────────

  health() {
    let walDepth = 0;
    try {
      if (this.walMode && fs.existsSync(this.walFile)) {
        const raw = fs.readFileSync(this.walFile, "utf8");
        walDepth  = raw.split("\n").filter(Boolean).length;
      }
    } catch (_) {}

    return {
      lastFlushMs:   this._lastFlushAt ?? null,   // epoch ms of last successful write
      walEnabled:    this.walMode,
      walDepth,                                   // events in current WAL segment
      historyLength: this.kernel.history.length,
      clock:         this.kernel.clock,
      restoreErrors: this._restoreErrors ?? [],
    };
  }

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
      this._lastFlushAt = Date.now();
    } catch (err) {
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
      // Serialise the event, compute a checksum, write as:
      //   <json>\t<ck>\n
      // The tab separator is safe because JSON never emits a bare tab.
      // _replayWal() verifies the checksum and skips corrupted lines.
      const json = JSON.stringify(evt);
      const ck   = fnv1a32(json);
      this._walStream.write(`${json}\t${ck}\n`);
      this._walDepth = (this._walDepth ?? 0) + 1;

      // Force a rotation if the WAL grows beyond the depth cap.
      // This prevents unbounded WAL growth between scheduled rotations.
      if (this._walDepth >= WAL_MAX_DEPTH) {
        console.warn(`[kernel-persist] WAL depth cap (${WAL_MAX_DEPTH}) reached — forcing rotation`);
        this._walDepth = 0;
        // Rotate asynchronously; snapshot write guards against concurrent writes.
        this._rotateWal();
      }
    } catch (_) {}
  }

  _replayWal() {
    let count   = 0;
    let corrupt = 0;
    try {
      const raw       = fs.readFileSync(this.walFile, "utf8");
      const lines     = raw.split("\n").filter(Boolean);
      const snapClock = this.kernel.clock;

      for (const line of lines) {
        try {
          // Lines written by _appendWal are "<json>\t<ck>".
          // Legacy lines (no checksum) are accepted without verification so
          // an upgrade does not invalidate existing WAL files.
          const tabIdx = line.lastIndexOf("\t");
          let jsonPart = line;
          let storedCk = null;
          if (tabIdx !== -1) {
            const candidate = line.slice(tabIdx + 1).trim();
            if (/^[0-9a-f]{8}$/.test(candidate)) {
              jsonPart = line.slice(0, tabIdx);
              storedCk = candidate;
            }
          }

          // Reject corrupted or tampered lines before touching the kernel.
          if (storedCk !== null && fnv1a32(jsonPart) !== storedCk) {
            console.warn("[kernel-persist] WAL entry checksum mismatch — skipping corrupted line");
            corrupt++;
            continue;
          }

          const entry = JSON.parse(jsonPart);
          if (entry.t <= snapClock) continue;
          if (
            entry.type &&
            !["DISPATCH_REJECTED","DISPATCH_FAILED","DISPATCH_THROTTLED","DISPATCH_UNKNOWN"].includes(entry.type)
          ) {
            this.kernel.dispatch({ ...entry.payload, type: entry.type, origin: "wal-replay" });
            count++;
          }
        } catch (_) {}
      }

      if (corrupt > 0) {
        console.warn(`[kernel-persist] WAL replay: ${corrupt} corrupted line(s) skipped`);
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
    // Flush current state to snapshot, archive the WAL segment, truncate,
    // then trim in-memory history.
    //
    // Archiving before truncation means peer sync can serve events from
    // archived segments even after the live history has been trimmed.
    // Segments are named wal-<clock>.ndjson and kept in the same dir.
    this._writeSnapshot().then(() => {
      try {
        // ── Archive segment before truncation ────────────────────────────────
        if (fs.existsSync(this.walFile)) {
          const segName = `wal-${this.kernel.clock}.ndjson`;
          const segPath = path.join(this.dir, segName);
          try {
            fs.copyFileSync(this.walFile, segPath);
            console.log(`[kernel-persist] WAL segment archived → ${segName}`);
          } catch (archErr) {
            console.warn("[kernel-persist] WAL archive failed (non-fatal):", archErr.message);
          }

          // Evict old segments — keep the most recent WAL_ARCHIVE_MAX
          this._evictOldSegments();
        }

        fs.writeFileSync(this.walFile, "", "utf8"); // truncate
        this._walDepth = 0;
        console.log("[kernel-persist] WAL rotated into snapshot");
      } catch (_) {}

      // Trim the in-memory history log: keep only events after the checkpoint
      // horizon. The snapshot written above encodes full state, so older entries
      // are only needed to re-replay events that arrived *after* the checkpoint.
      const { KernelReplayer } = require("./kernel-replay");
      const replayer  = new KernelReplayer();
      const trimClock = Math.max(0, this.kernel.clock - KernelPersist.CHECKPOINT_DEPTH);
      const trimmed   = replayer.trim(this.kernel.history, trimClock);
      this.kernel.history = trimmed;
      console.log(
        `[kernel-persist] History trimmed to ${trimmed.length} events ` +
        `(horizon clock=${trimClock})`
      );
    });
  }

  /**
   * Return a list of archived WAL segment paths sorted oldest-first.
   * Used by KernelSync.handlePullRequest() to serve history before the
   * live trim horizon.
   */
  archivedSegments() {
    try {
      return fs.readdirSync(this.dir)
        .filter(f => /^wal-\d+\.ndjson$/.test(f))
        .sort((a, b) => {
          const clockA = parseInt(a.match(/\d+/)[0], 10);
          const clockB = parseInt(b.match(/\d+/)[0], 10);
          return clockA - clockB;
        })
        .map(f => path.join(this.dir, f));
    } catch (_) {
      return [];
    }
  }

  /**
   * Read events from archived segments that fall after sinceClock.
   * Returns a flat array of history entries for peer pull responses.
   */
  readArchivedSince(sinceClock) {
    const entries = [];
    for (const segPath of this.archivedSegments()) {
      try {
        const raw   = fs.readFileSync(segPath, "utf8");
        const lines = raw.split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const tabIdx = line.lastIndexOf("\t");
            let jsonPart = line;
            if (tabIdx !== -1) {
              const candidate = line.slice(tabIdx + 1).trim();
              if (/^[0-9a-f]{8}$/.test(candidate)) jsonPart = line.slice(0, tabIdx);
            }
            const entry = JSON.parse(jsonPart);
            if (typeof entry.t === "number" && entry.t > sinceClock) {
              entries.push(entry);
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
    return entries;
  }

  /** Remove oldest archived segments when count exceeds WAL_ARCHIVE_MAX. */
  _evictOldSegments() {
    const segments = this.archivedSegments();
    const excess   = segments.length - KernelPersist.WAL_ARCHIVE_MAX;
    if (excess <= 0) return;
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(segments[i]); } catch (_) {}
    }
    if (excess > 0) {
      console.log(`[kernel-persist] Evicted ${excess} old WAL segment(s)`);
    }
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

/** How many clock ticks to keep in the live history log after each WAL rotation. */
KernelPersist.CHECKPOINT_DEPTH = 5_000;

/** Maximum number of archived WAL segment files to retain on disk. */
KernelPersist.WAL_ARCHIVE_MAX = 20;

module.exports = { KernelPersist, attachPersistence };
