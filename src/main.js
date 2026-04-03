/**
 * SOVEREIGN NET OS — Electron Main Process
 *
 * All mutable state lives inside the kernel.
 * Nothing in this file touches state directly —
 * every mutation goes through kernel.dispatch().
 *
 * Architecture:
 *   IPC call → kernel.dispatch(event) → constrained handler → effect → renderer push
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const path       = require('path');
const { spawn }  = require('child_process');
const fs         = require('fs');
const http       = require('http');
const nodeCrypto = require('crypto');

// ── Kernel ─────────────────────────────────────────────────────────────────
const { DispatchKernel, createIpcBridge } = require('./kernel');
const { attachPersistence }              = require('./kernel-persist');
const { attachReplayBridge }             = require('./kernel-replay');
const { KernelSync, attachSyncBridge }   = require('./kernel-sync');
const { applyKuboConfig }               = require('./kubo-config');

const kernel = new DispatchKernel({
  maxUnits:  500_000,  // reset every 60s by scheduler
  seed:      Date.now() & 0xFFFFFFFF,
});

// ── Optional: add a sig validation step ────────────────────────────────────
// kernel.sig.use(event => {
//   if (event.origin === 'renderer' && !event.sig) throw new KernelError('UNSIGNED', 'Renderer events require a signature');
// });

// ── Constants ──────────────────────────────────────────────────────────────
const IPFS_API   = 'http://127.0.0.1:5001';
const IPFS_GW    = 'http://127.0.0.1:8080';
const IS_DEV     = process.argv.includes('--dev');
const IS_MAC     = process.platform === 'darwin';
const IS_WIN     = process.platform === 'win32';

// BW and reputation state → managed by kernel.dispatch()

let mainWindow = null;
let tray       = null;
let ipfsProc   = null;   // only set if WE spawned the daemon

// ── Utility: small HTTP request helper (avoids fetch in main process) ──────
function httpPost(url, body = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port:     urlObj.port || 5001,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers:  body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Check if Kubo daemon is already running ────────────────────────────────
async function isDaemonRunning() {
  return new Promise(resolve => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 5001,
      path: '/api/v0/version',
      method: 'POST'
    }, res => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ── Try to find the ipfs / kubo binary ────────────────────────────────────
function findIpfsBinary() {
  // 1. Bundled binary next to our app
  const bundled = path.join(process.resourcesPath || __dirname, '..', 'bin',
                            IS_WIN ? 'ipfs.exe' : 'ipfs');
  if (fs.existsSync(bundled)) return bundled;

  // 2. Common install locations
  const candidates = IS_WIN
    ? [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'kubo', 'ipfs.exe'),
        'C:\\Program Files\\Kubo\\ipfs.exe'
      ]
    : [
        '/usr/local/bin/ipfs',
        '/usr/bin/ipfs',
        path.join(process.env.HOME || '', 'go', 'bin', 'ipfs'),
        '/opt/homebrew/bin/ipfs',
        '/snap/bin/ipfs'
      ];

  for (const c of candidates) if (fs.existsSync(c)) return c;

  // 3. Let the OS find it via PATH
  return 'ipfs';
}

// ── Daemon restart backoff state ───────────────────────────────────────────
let _daemonRestartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 3;

// ── Start the Kubo daemon (if not already running) ─────────────────────────
// Improvements over the original:
//   1. Delegates ALL config to kubo-config.js (bootstrap, DHT, MDNS, ConnMgr, NAT)
//   2. Detects corrupted repos (config exists but is invalid JSON) and re-inits
//   3. Retries daemon start up to MAX_RESTART_ATTEMPTS times with exponential backoff
//   4. Auto-restarts on unexpected exit (not triggered by app.quit)
//   5. Graceful stop is wired in the before-quit handler at the bottom of the file
async function ensureIpfsDaemon(onLog) {
  if (await isDaemonRunning()) {
    onLog('✓ Kubo daemon already running on localhost:5001');
    _daemonRestartAttempts = 0;
    return;
  }

  if (_daemonRestartAttempts >= MAX_RESTART_ATTEMPTS) {
    onLog(`⚠ Daemon failed to start after ${MAX_RESTART_ATTEMPTS} attempts — check PATH and repo`);
    return;
  }

  _daemonRestartAttempts++;
  const bin      = findIpfsBinary();
  const repoPath = process.env.IPFS_PATH || path.join(app.getPath('userData'), 'ipfs-repo');

  onLog(`Starting Kubo daemon (attempt ${_daemonRestartAttempts}/${MAX_RESTART_ATTEMPTS}): ${bin}`);

  // ── Repo init / corruption recovery ─────────────────────────────────────
  const configPath = path.join(repoPath, 'config');
  let needsInit    = !fs.existsSync(configPath);

  if (!needsInit) {
    // Verify config is valid JSON; re-init if it's corrupted
    try {
      JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      onLog('⚠ IPFS repo config corrupted — re-initialising repo');
      try { fs.rmSync(repoPath, { recursive: true, force: true }); } catch (_) {}
      needsInit = true;
    }
  }

  if (needsInit) {
    onLog('Initialising IPFS repo at ' + repoPath);
    try {
      await new Promise((res, rej) => {
        const init = spawn(bin, ['init'], { env: { ...process.env, IPFS_PATH: repoPath } });
        init.stderr.on('data', d => onLog(d.toString().trim()));
        init.on('close', code => code === 0 ? res() : rej(new Error('ipfs init failed: ' + code)));
      });
    } catch (initErr) {
      onLog('✗ ipfs init failed: ' + initErr.message);
      const backoff = 5000 * _daemonRestartAttempts;
      onLog(`Retrying in ${backoff / 1000}s…`);
      setTimeout(() => ensureIpfsDaemon(onLog), backoff);
      return;
    }
  }

  // ── Apply full Kubo config (bootstrap + DHT + MDNS + ConnMgr + NAT + pubsub) ──
  try {
    await applyKuboConfig(bin, repoPath, onLog);
  } catch (cfgErr) {
    onLog('Config warning: ' + cfgErr.message); // non-fatal
  }

  // ── Launch the daemon ────────────────────────────────────────────────────
  ipfsProc = spawn(
    bin,
    ['daemon', '--enable-pubsub-experiment', '--migrate=true'],
    { env: { ...process.env, IPFS_PATH: repoPath }, detached: false }
  );

  ipfsProc.stdout.on('data', d => onLog(d.toString().trim()));
  ipfsProc.stderr.on('data', d => onLog(d.toString().trim()));
  ipfsProc.on('error', err => {
    onLog('Daemon process error: ' + err.message);
    ipfsProc = null;
  });
  ipfsProc.on('close', code => {
    onLog(`Daemon exited (code ${code})`);
    ipfsProc = null;
    // Auto-restart on unexpected exit (not triggered by intentional app quit)
    if (!app.isQuitting && code !== 0) {
      const backoff = 5000 * _daemonRestartAttempts;
      onLog(`Unexpected daemon exit — restarting in ${backoff / 1000}s…`);
      setTimeout(() => ensureIpfsDaemon(onLog), backoff);
    }
  });

  // ── Wait until the API is up (max 45 s, poll every 500 ms) ──────────────
  let waited = 0;
  const MAX_WAIT = 45_000;
  while (!(await isDaemonRunning()) && waited < MAX_WAIT) {
    await new Promise(r => setTimeout(r, 500));
    waited += 500;
  }

  if (await isDaemonRunning()) {
    onLog('✓ Kubo daemon ready');
    _daemonRestartAttempts = 0; // reset on success
  } else {
    onLog('⚠ Daemon did not start within 45 s — scheduling retry');
    ipfsProc?.kill('SIGTERM');
    ipfsProc = null;
    const backoff = 5000 * _daemonRestartAttempts;
    setTimeout(() => ensureIpfsDaemon(onLog), backoff);
  }
}

// ── Create BrowserWindow ───────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1440,
    height: 900,
    minWidth:  900,
    minHeight: 600,
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    backgroundColor: '#050507',
    webPreferences: {
      preload:            path.join(__dirname, 'preload.js'),
      contextIsolation:   true,
      nodeIntegration:    false,
      // Allow fetch to localhost:5001 / 8080 from the renderer
      webSecurity:        !IS_DEV, // relax in dev; tighten in prod via preload bridge
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));

  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('close', e => {
    if (!IS_MAC) return;
    e.preventDefault();
    mainWindow.hide(); // keep daemon alive, just hide
  });

  // Push daemon log lines to the renderer's console view
  mainWindow.webContents.on('did-finish-load', () => {
    ensureIpfsDaemon(line => {
      mainWindow?.webContents?.send('ipfs:log', line);
    });
  });
}

// ── System Tray ───────────────────────────────────────────────────────────
function createTray() {
  // Use a small 16×16 nativeImage; replace with your own icon
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAA' +
    'iklEQVQ4jWNgYGD4z8BQDwADhAH/YGBg+M/AwAAA' // placeholder 1-px icon
  );
  tray = new Tray(icon);
  const menu = Menu.buildFromTemplate([
    { label: 'Open Sovereign Net OS', click: () => { mainWindow?.show(); } },
    { label: 'IPFS WebUI', click: () => shell.openExternal('http://127.0.0.1:5001/webui') },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setToolTip('Sovereign Net OS');
  tray.setContextMenu(menu);
  tray.on('click', () => mainWindow?.show());
}

// ── IPC Bridge: renderer → main → IPFS API ────────────────────────────────
// The renderer calls window.ipfs.api(path, opts) and gets a Promise back.
// This sidesteps CORS entirely since the request originates from main process.

ipcMain.handle('ipfs:api', async (_event, { path: apiPath, method = 'POST', formData, query }) => {
  const url = `${IPFS_API}/api/v0${apiPath}${query ? '?' + new URLSearchParams(query).toString() : ''}`;

  if (formData) {
    // Multipart upload — use Node's http directly
    const boundary = '----SovereignNetBoundary' + Date.now();
    const buffers = [];
    for (const [name, value] of Object.entries(formData)) {
      const filename = value.name || name;
      const isBuffer = Buffer.isBuffer(value.data);
      buffers.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`
      ));
      buffers.push(isBuffer ? value.data : Buffer.from(value.data));
      buffers.push(Buffer.from('\r\n'));
    }
    buffers.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(buffers);

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const req = http.request({
        hostname: urlObj.hostname,
        port:     urlObj.port || 5001,
        path:     urlObj.pathname + urlObj.search,
        method:   'POST',
        headers: {
          'Content-Type':   `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      }, res => {
        let d = '';
        res.on('data', chunk => d += chunk);
        res.on('end', () => {
          try { resolve({ ok: res.statusCode < 300, status: res.statusCode, body: JSON.parse(d) }); }
          catch { resolve({ ok: res.statusCode < 300, status: res.statusCode, body: d }); }
        });
      });
      req.on('error', e => resolve({ ok: false, error: e.message }));
      req.write(body);
      req.end();
    });
  }

  // Normal POST (no body or simple body)
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname,
      port:     urlObj.port || 5001,
      path:     urlObj.pathname + urlObj.search,
      method
    }, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 300, status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ ok: res.statusCode < 300, status: res.statusCode, body: d }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.end();
  });
});

// ── Streaming Pubsub IPC Handler ──────────────────────────────────────────
// This replaces the broken polling approach in ipfsAdapter.js.
//
// How it works:
//   1. Renderer calls window.ipfs.pubsubSubscribe(topic) via preload bridge.
//   2. Main process opens a persistent streaming HTTP connection to
//      /api/v0/pubsub/sub?arg=<topic>  (Kubo streams newline-delimited JSON).
//   3. Each arriving message is forwarded to the renderer via
//      mainWindow.webContents.send('pubsub:msg', { topic, ...parsedMsg }).
//   4. Renderer calls window.ipfs.pubsubUnsubscribe(topic) to tear down.
//
// Protocol detail:
//   Kubo's pubsub/sub response body is a stream of JSON objects, one per line.
//   Each object: { from: "<base64 peer id>", data: "<base64 payload>", ... }
//   We decode both fields before forwarding.
//
// Active subscriptions are tracked in _pubsubStreams so we can clean up.

const _pubsubStreams = new Map(); // topic → { req, aborted }

ipcMain.handle('pubsub:subscribe', async (_event, topic) => {
  if (_pubsubStreams.has(topic)) return { ok: true, already: true };

  const urlObj  = new URL(`${IPFS_API}/api/v0/pubsub/sub`);
  urlObj.searchParams.set('arg', topic);

  const state = { req: null, aborted: false };
  _pubsubStreams.set(topic, state);

  function openStream() {
    if (state.aborted) return;

    const req = http.request({
      hostname: urlObj.hostname,
      port:     urlObj.port || 5001,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers:  { 'Connection': 'keep-alive' },
    });

    state.req = req;

    req.on('response', res => {
      let buf = '';
      res.on('data', chunk => {
        buf += chunk.toString();
        // Kubo sends one JSON object per line
        const lines = buf.split('\n');
        buf = lines.pop(); // keep any partial line
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            // Decode base64 fields
            const from    = msg.from    ? Buffer.from(msg.from,    'base64').toString('utf8') : msg.from;
            const dataStr = msg.data    ? Buffer.from(msg.data,    'base64').toString('utf8') : '';
            mainWindow?.webContents?.send('pubsub:msg', {
              topic,
              from,
              data:       dataStr,
              seqno:      msg.seqno,
              topicIDs:   msg.topicIDs,
            });
          } catch (_) { /* malformed line — skip */ }
        }
      });

      res.on('end', () => {
        // Kubo closed the stream (e.g. daemon restart) — reconnect after a delay
        if (!state.aborted) {
          setTimeout(openStream, 2000);
        }
      });
    });

    req.on('error', () => {
      // Daemon not reachable yet — retry
      if (!state.aborted) {
        setTimeout(openStream, 3000);
      }
    });

    req.end();
  }

  openStream();
  return { ok: true };
});

ipcMain.handle('pubsub:unsubscribe', async (_event, topic) => {
  const state = _pubsubStreams.get(topic);
  if (!state) return { ok: true };
  state.aborted = true;
  try { state.req?.destroy(); } catch (_) {}
  _pubsubStreams.delete(topic);
  return { ok: true };
});

// ── App identity — must be set before app.whenReady() ─────────────────────
// Electron derives the userData path from app.getName(). If this isn't set
// explicitly, it falls back to package.json `name`, which may be sanitised
// differently per platform (hyphens stripped, casing changed) or return
// undefined on some Electron versions before the app is fully ready.
// Setting app.name here guarantees app.getPath('userData') is stable and
// never contains "undefined" as a path component.
app.name = 'Sovereign Net OS';

// ── IPC bridge: all state mutations via kernel.dispatch() ─────────────────
// createIpcBridge wires rep:*, bw:*, kernel:dispatch, kernel:query, kernel:snapshot
// Effects (ban push, bw change push) are registered inside the bridge.
// Called after mainWindow exists so effects can push to renderer.

// ── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // ── 0. Security: register sig validators before any dispatch ──────────────
  //
  //    Validator A — Origin allowlist
  //    Every event must declare a known, trusted origin string.
  //    Un-recognised origins are rejected immediately, preventing spoofed
  //    events from slipping through if a new code path forgets to set origin.
  const ALLOWED_ORIGINS = new Set([
    "internal",   // kernel built-ins and effects
    "ipc",        // IPC bridge helpers (mut() in createIpcBridge)
    "renderer",   // generic kernel:dispatch calls from the renderer
    "scheduler",  // setInterval-driven PEER_REP_DECAY / KERNEL_RESET_UNITS
    "replay",     // KernelReplayer.replay()
    "wal-replay", // KernelPersist._replayWal()
  ]);
  kernel.sig.use((event) => {
    const origin = event.origin ?? "internal";
    if (!ALLOWED_ORIGINS.has(origin) && !origin.startsWith("peer:")) {
      const { KernelError } = require("./kernel");
      throw new KernelError(
        "INVALID_ORIGIN",
        `Event type ${event.type} carries unknown origin "${origin}"`
      );
    }
  });

  //    Validator B — Peer signature verification + payload-size gate
  //    Peer-origin events MUST carry a valid ECDSA P-256 signature over the
  //    canonical event bytes (type:origin:clock:JSON(payload)).
  //    The signing key must have been previously registered via
  //    PEER_PUBKEY_REGISTER — unknown peers are rejected outright.
  //    Payload is also capped at 64 KB to prevent WAL flooding.
  const MAX_PEER_PAYLOAD_BYTES = 65_536; // 64 KB
  const nodeCrypto = require("crypto");

  // Canonical bytes for a peer event — must match what kernel-sync signs.
  // Mirrors the _uid() logic: clock:type:origin:JSON(payload)
  function canonicalEventBytes(event) {
    const raw = `${event.clock ?? 0}:${event.type}:${event.origin}:${JSON.stringify(event.payload ?? {})}`;
    return Buffer.from(raw, "utf8");
  }

  kernel.sig.use((event) => {
    if (typeof event.origin === "string" && event.origin.startsWith("peer:")) {
      // ── Payload size gate (always checked, even before sig) ───────────────
      const payloadBytes = JSON.stringify(event.payload ?? {}).length;
      if (payloadBytes > MAX_PEER_PAYLOAD_BYTES) {
        const { KernelError } = require("./kernel");
        throw new KernelError(
          "PEER_PAYLOAD_TOO_LARGE",
          `Peer payload ${payloadBytes} B from ${event.origin} exceeds ${MAX_PEER_PAYLOAD_BYTES} B limit`
        );
      }

      // ── Signature required ────────────────────────────────────────────────
      if (!event.sig) {
        const { KernelError } = require("./kernel");
        throw new KernelError(
          "UNSIGNED_PEER_EVENT",
          `Peer event from ${event.origin} rejected: missing sig field`
        );
      }

      // ── Pubkey lookup ─────────────────────────────────────────────────────
      const senderId = event.origin.slice(5); // strip "peer:"
      const pubKeyB64 = kernel.query("PEER_PUBKEY", senderId);
      if (!pubKeyB64) {
        // Unknown peer — reject until they announce their pubkey via
        // PEER_PUBKEY_REGISTER (sent in the first sync envelope).
        // Do not throw a hard error here so the kernel can still accept
        // PEER_PUBKEY_REGISTER events from unknown origins when we relax
        // below for that specific type.
        if (event.type !== "PEER_PUBKEY_REGISTER") {
          const { KernelError } = require("./kernel");
          throw new KernelError(
            "UNKNOWN_PEER_PUBKEY",
            `No registered pubkey for peer ${senderId} — cannot verify event ${event.type}`
          );
        }
        return; // allow PEER_PUBKEY_REGISTER through unsigned so peers can introduce themselves
      }

      // ── Real ECDSA P-256 verification ─────────────────────────────────────
      try {
        const spkiDer  = Buffer.from(pubKeyB64, "base64");
        const sigBuf   = Buffer.from(event.sig,  "base64");
        const msgBytes = canonicalEventBytes(event);

        // Node's crypto.verify() with SPKI DER key and DER-encoded ECDSA sig
        const ok = nodeCrypto.verify(
          "SHA256",          // digest algo
          msgBytes,          // data
          {
            key:    spkiDer,
            format: "der",
            type:   "spki",
            dsaEncoding: "der",
          },
          sigBuf
        );
        if (!ok) {
          const { KernelError } = require("./kernel");
          throw new KernelError(
            "BAD_PEER_SIG",
            `Signature verification failed for peer ${senderId} on event ${event.type}`
          );
        }
      } catch (err) {
        if (err.code === "KERNEL_ERROR" || err.name === "KernelError") throw err;
        const { KernelError } = require("./kernel");
        throw new KernelError(
          "SIG_VERIFY_ERROR",
          `Sig verify error for peer ${senderId}: ${err.message}`
        );
      }
    }
  });

  // ── 1. Restore kernel state from disk ─────────────────────────────────────
  //    WAL mode MUST be true in production.  Without it a crash between the
  //    debounced snapshot writes (3 s window) silently loses committed events.
  //    The write-ahead log gives us crash-safe persistence with <1 event loss.
  //    DO NOT set wal: false — see audit note in README § Security Hardening.
  attachPersistence(kernel, app, { wal: true });

  // ── 2. Create window + tray ────────────────────────────────────────────────
  createWindow();
  createTray();

  // ── 3. Wire all IPC through the kernel ────────────────────────────────────
  //    (createIpcBridge needs mainWindow for effect→renderer pushes)
  createIpcBridge(kernel, ipcMain, mainWindow);

  // ── 4. Wire replay IPC (pass mainWindow so divergence pushes reach the UI) ─
  attachReplayBridge(kernel, ipcMain, mainWindow);

  // ── 4a. Persist health IPC — status panel reads last flush, WAL depth, etc ─
  ipcMain.handle("kernel:persist:health", async () => {
    try {
      return { ok: true, result: kernel._persist?.health() ?? null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── 5. Kubo side-effects (disconnect banned peers, apply BW limits) ────────
  kernel.effect('PEER_REP_EVENT', (result) => {
    if (result.freshBan) {
      httpPost(`${IPFS_API}/api/v0/swarm/disconnect?arg=/p2p/${result.peerId}`).catch(() => {});
    }
  });

  kernel.effect('BW_SET_LIMITS', async (result) => {
    try {
      const limits = {
        System: {
          ...(result.upload   > 0 ? { StreamsOutbound: Math.floor(result.upload   / 1024) } : {}),
          ...(result.download > 0 ? { StreamsInbound:  Math.floor(result.download / 1024) } : {}),
        }
      };
      await httpPost(
        `${IPFS_API}/api/v0/swarm/resourcemanager/limit?scope=system`,
        JSON.stringify(limits)
      );
    } catch (_) { /* non-fatal on older Kubo */ }
  });

  // ── 6. BW upload check (reads Kubo stats + kernel limits) ─────────────────
  ipcMain.handle('bw:checkUpload', async (_e, fileSizeBytes) => {
    const limits = kernel.query('BW_LIMITS');
    if (!limits.upload) return { allowed: true };
    try {
      const { body } = await httpPost(`${IPFS_API}/api/v0/stats/bw`);
      const rateOut  = body?.RateOut || 0;
      const allowed  = rateOut + (fileSizeBytes / 5) <= limits.upload;
      return { allowed, rateOut, limit: limits.upload };
    } catch {
      return { allowed: true };
    }
  });

  // ── 7. Start kernel sync once node identity is known ──────────────────────
  //    (IDENTITY_SET fires when ipfsAdapter syncs the real peer ID)
  //
  //    We generate a persistent ECDSA P-256 signing key for this node on first
  //    boot and store it in the kernel userData dir alongside the snapshot.
  //    The DER-encoded private key never leaves the main process.
  //    The base64 SPKI public key is broadcast in every sync envelope so peers
  //    can register it and verify our event signatures.
  kernel.effect('IDENTITY_SET', (result) => {
    if (kernel._sync) return; // already started
    const nodeId = result?.peerId;
    if (!nodeId) return;

    // ── Load or generate node signing key ───────────────────────────────────
    const keyDir      = path.join(app.getPath('userData'), 'kernel');
    const privKeyPath = path.join(keyDir, 'node-signing.key');  // PKCS8 DER, base64
    const pubKeyPath  = path.join(keyDir, 'node-signing.pub');  // SPKI DER, base64

    let signingKey = null;
    try {
      if (fs.existsSync(privKeyPath) && fs.existsSync(pubKeyPath)) {
        const privateKeyDer = Buffer.from(fs.readFileSync(privKeyPath, 'utf8').trim(), 'base64');
        const pubKeyB64     = fs.readFileSync(pubKeyPath, 'utf8').trim();
        signingKey = { privateKeyDer, pubKeyB64 };
        console.log('[main] Loaded existing node signing key');
      } else {
        const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync('ec', {
          namedCurve:           'P-256',
          privateKeyEncoding:   { type: 'pkcs8', format: 'der' },
          publicKeyEncoding:    { type: 'spki',  format: 'der' },
        });
        fs.mkdirSync(keyDir, { recursive: true });
        const pubKeyB64  = publicKey.toString('base64');
        fs.writeFileSync(privKeyPath, privateKey.toString('base64'), 'utf8');
        fs.writeFileSync(pubKeyPath,  pubKeyB64,                     'utf8');
        signingKey = { privateKeyDer: privateKey, pubKeyB64 };
        console.log('[main] Generated new node signing key');
        // Register our own pubkey so self-originated replays don't trip the
        // unknown-peer guard if they're ever re-dispatched with a peer origin.
        kernel.dispatch({
          type:    'PEER_PUBKEY_REGISTER',
          payload: { peerId: nodeId, pubKeyB64 },
          origin:  'internal',
        });
      }
    } catch (keyErr) {
      console.error('[main] Signing key setup failed (sync will run unsigned):', keyErr.message);
    }

    const sync = new KernelSync(kernel, nodeId, httpPost, 'global', {
      persist:    kernel._persist ?? null,
      signingKey,
    });
    kernel._sync = sync;
    attachSyncBridge(sync, ipcMain);
    sync.start({ broadcastMs: 5_000, pollMs: 3_000 });
    console.log(`[main] Kernel sync started for node ${nodeId}`);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  // Flush kernel state to disk before exit
  kernel._persist?.flushSync();
  // Tear down all active pubsub streams cleanly
  for (const [, state] of _pubsubStreams) {
    state.aborted = true;
    try { state.req?.destroy(); } catch (_) {}
  }
  _pubsubStreams.clear();
  // Stop the IPFS daemon if we spawned it
  if (ipfsProc) {
    ipfsProc.kill('SIGTERM');
    ipfsProc = null;
  }
});
