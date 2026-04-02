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
const path  = require('path');
const { spawn } = require('child_process');
const fs    = require('fs');
const http  = require('http');

// ── Kernel ─────────────────────────────────────────────────────────────────
const { DispatchKernel, createIpcBridge } = require('./kernel');
const { attachPersistence }              = require('./kernel-persist');
const { attachReplayBridge }             = require('./kernel-replay');
const { KernelSync, attachSyncBridge }   = require('./kernel-sync');

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

// ── NAT Traversal constants ────────────────────────────────────────────────
// Kubo supports AutoNAT, Circuit Relay v2, and Hole Punching natively.
// We enable them explicitly so they aren't disabled by stripped-down configs.
const NAT_CONFIG = {
  'AutoNAT.ServiceMode':          'enabled',           // advertise NAT service to others
  'Swarm.EnableHolePunching':     true,                // DCUtR hole punching
  'Swarm.RelayClient.Enabled':    true,                // use relay if direct fails
  'Swarm.RelayService.Enabled':   true,                // act as relay for others
  'Swarm.Transports.Network.Relay': true,
};

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

// ── Start the Kubo daemon (if not already running) ─────────────────────────
async function ensureIpfsDaemon(onLog) {
  if (await isDaemonRunning()) {
    onLog('✓ Kubo daemon already running on localhost:5001');
    return;
  }

  const bin = findIpfsBinary();
  onLog(`Starting Kubo daemon: ${bin}`);

  // Initialise repo if needed
  const repoPath = process.env.IPFS_PATH || path.join(app.getPath('userData'), 'ipfs-repo');
  if (!fs.existsSync(path.join(repoPath, 'config'))) {
    onLog('Initialising IPFS repo at ' + repoPath);
    await new Promise((res, rej) => {
      const init = spawn(bin, ['init'], { env: { ...process.env, IPFS_PATH: repoPath } });
      init.stderr.on('data', d => onLog(d.toString().trim()));
      init.on('close', code => code === 0 ? res() : rej(new Error('ipfs init failed: ' + code)));
    });
  }

  // Enable pubsub + NAT traversal in config
  try {
    await new Promise((res, rej) => {
      const p = spawn(bin, ['config', '--json', 'Pubsub.Enabled', 'true'],
                      { env: { ...process.env, IPFS_PATH: repoPath } });
      p.on('close', res);
    });

    // ── NAT traversal: AutoNAT, DCUtR hole punching, Circuit Relay v2 ────
    onLog('Applying NAT traversal configuration…');
    for (const [key, value] of Object.entries(NAT_CONFIG)) {
      await new Promise(res => {
        const p = spawn(bin, ['config', '--json', key, JSON.stringify(value)],
                        { env: { ...process.env, IPFS_PATH: repoPath } });
        p.stderr.on('data', d => onLog(`  config ${key}: ${d.toString().trim()}`));
        p.on('close', res);
      });
    }
    onLog('✓ NAT traversal config applied (AutoNAT + DCUtR + RelayV2)');
    // Allow CORS for our renderer (localhost:5001 API)
    const corsOrigins = JSON.stringify(['*']);
    await new Promise(res => {
      const p = spawn(bin, ['config', '--json', 'API.HTTPHeaders.Access-Control-Allow-Origin', corsOrigins],
                      { env: { ...process.env, IPFS_PATH: repoPath } });
      p.on('close', res);
    });
    await new Promise(res => {
      const p = spawn(bin, ['config', '--json', 'API.HTTPHeaders.Access-Control-Allow-Methods',
                            '["PUT","POST","GET"]'],
                      { env: { ...process.env, IPFS_PATH: repoPath } });
      p.on('close', res);
    });
  } catch (e) { onLog('Config warning: ' + e.message); }

  // Launch the daemon
  ipfsProc = spawn(bin, ['daemon', '--enable-pubsub-experiment'],
                   { env: { ...process.env, IPFS_PATH: repoPath }, detached: false });

  ipfsProc.stdout.on('data', d => onLog(d.toString().trim()));
  ipfsProc.stderr.on('data', d => onLog(d.toString().trim()));
  ipfsProc.on('error', err => onLog('Daemon error: ' + err.message));
  ipfsProc.on('close', code => {
    onLog(`Daemon exited (code ${code})`);
    ipfsProc = null;
  });

  // Wait until the API is up (max 30 s)
  let waited = 0;
  while (!(await isDaemonRunning()) && waited < 30000) {
    await new Promise(r => setTimeout(r, 500));
    waited += 500;
  }
  if (await isDaemonRunning()) onLog('✓ Kubo daemon ready');
  else onLog('⚠ Daemon did not start within 30 s — check PATH');
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

// ── IPC bridge: all state mutations via kernel.dispatch() ─────────────────
// createIpcBridge wires rep:*, bw:*, kernel:dispatch, kernel:query, kernel:snapshot
// Effects (ban push, bw change push) are registered inside the bridge.
// Called after mainWindow exists so effects can push to renderer.

// ── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // ── 1. Restore kernel state from disk ─────────────────────────────────────
  attachPersistence(kernel, app, { wal: false });

  // ── 2. Create window + tray ────────────────────────────────────────────────
  createWindow();
  createTray();

  // ── 3. Wire all IPC through the kernel ────────────────────────────────────
  //    (createIpcBridge needs mainWindow for effect→renderer pushes)
  createIpcBridge(kernel, ipcMain, mainWindow);

  // ── 4. Wire replay IPC ────────────────────────────────────────────────────
  attachReplayBridge(kernel, ipcMain);

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
  kernel.effect('IDENTITY_SET', (result) => {
    if (kernel._sync) return; // already started
    const nodeId = result?.peerId;
    if (!nodeId) return;

    const sync = new KernelSync(kernel, nodeId, httpPost, 'global');
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
  // Stop the IPFS daemon if we spawned it
  if (ipfsProc) {
    ipfsProc.kill('SIGTERM');
    ipfsProc = null;
  }
});
