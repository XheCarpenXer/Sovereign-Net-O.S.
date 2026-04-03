# SOVEREIGN NET OS

> *You are not using the internet. You are the internet.*

**A fully decentralized operating system that runs in a single browser tab — no install, no server, no cloud.**

`index.html` is not a demo. It is a complete sovereign node: P2P mesh networking, Merkle-DAG versioned code editor, end-to-end encrypted messaging, decentralized social feed, CID-addressed file storage, peer video streaming, drag-and-drop app builder, live network visualization, security auditor, local AI inference, and a 30+ command terminal — all in one self-contained file.

Open it. You are the node.

---

## Table of Contents

- [What Is This](#what-is-this)
- [Quick Start — Browser](#quick-start--browser)
- [Quick Start — Desktop (Electron + Real IPFS)](#quick-start--desktop-electron--real-ipfs)
- [Features](#features)
  - [Home Dashboard](#-home-dashboard)
  - [Code Editor](#-code-editor)
  - [Messenger](#-messenger)
  - [Social Feed](#-social-feed)
  - [Files](#-files)
  - [Video](#-video)
  - [Network](#-network)
  - [Marketplace](#-marketplace)
  - [App Builder](#-app-builder)
  - [Console / Terminal](#-console--terminal)
  - [Identity](#-identity)
  - [Security Auditor](#-security-auditor)
  - [AI Compute Node](#-ai-compute-node)
- [Architecture](#architecture)
  - [Identity & Keys](#identity--keys)
  - [Networking & Mesh](#networking--mesh)
  - [Storage & DAG](#storage--dag)
  - [Crypto Layer](#crypto-layer)
  - [State Sync (CRDT)](#state-sync-crdt)
  - [Sandboxed Execution](#sandboxed-execution)
  - [Security Engine (RRTK)](#security-engine-rrtk)
  - [AI Engine](#ai-engine)
- [Electron / IPFS Integration](#electron--ipfs-integration)
  - [How It Works](#how-it-works)
  - [window.ipfs API](#windowipfs-api)
  - [What ipfsAdapter.js Replaces](#what-ipfsadapterjs-replaces)
  - [Daemon Lifecycle](#daemon-lifecycle)
- [Directory Layout](#directory-layout)
- [Building for Distribution](#building-for-distribution)
  - [Bundling Kubo](#bundling-kubo-zero-dependency-install)
- [Console Command Reference](#console-command-reference)
- [AI Compute Node — Setup & Usage](#ai-compute-node--setup--usage)
- [Patch Notes](#patch-notes)
- [Roadmap](#roadmap)
- [License](#license)

---

## What Is This

Sovereign Net OS is an experiment in proving that an entire networked operating system — identity, storage, messaging, social, code execution, AI inference — can run without any central authority. No DNS. No CDN. No backend. No API key.

Every capability is implemented using Web platform primitives:

- **BroadcastChannel** for real multi-tab P2P mesh networking
- **IndexedDB** for persistent, structured local storage
- **Web Crypto API** for ECDSA P-256 signatures and AES-256-GCM encryption
- **SubtleCrypto** for CID hashing and key derivation
- **ReadableStream** for streaming AI inference output
- **WebRTC** (simulated in browser, real in Electron) for direct peer channels

When wrapped in Electron, simulated subsystems are replaced with a live [Kubo](https://github.com/ipfs/kubo) IPFS daemon — real peers, real CIDs, real pubsub, real bandwidth stats.

---

## Quick Start — Browser

No install. No build step. No internet required after download.

1. Download `index.html`
2. Open it in Chrome, Edge, or Firefox
3. Open 2–4 tabs side by side — they auto-discover each other via `BroadcastChannel` and form a live mesh

**That's it.** Peer discovery, ECDSA P-256 signed commits, AES-256-GCM encrypted channels, CID-addressed DAG storage, and gossip-protocol state sync all run locally in your browser across tabs.

> **Tip:** Open tabs in different windows (not just different tabs in the same window) to better simulate distinct nodes. Each tab generates its own DID and keypair on first run.

---

## Quick Start — Desktop (Electron + Real IPFS)

Wraps `index.html` in an Electron shell with a real [Kubo](https://github.com/ipfs/kubo) IPFS daemon underneath. All simulated data is replaced with live IPFS peers, real CIDs, genuine pubsub, and actual bandwidth statistics.

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 18+ | https://nodejs.org |
| Kubo (go-ipfs) | Any recent | `brew install ipfs` · [Linux/Windows](https://docs.ipfs.tech/install/command-line/) |

### Setup

```bash
# 1. Ensure index.html and src/ are in the same directory
# 2. Run the setup script — installs npm deps, detects Kubo, injects ipfsAdapter
bash scripts/setup.sh

# 3. Launch
npm start

# Dev mode (opens DevTools automatically)
npm run dev
```

`setup.sh` handles everything: dependency installation, Kubo binary detection, and injecting `src/ipfsAdapter.js` into `index.html` before `</body>`. Do not edit `index.html` manually before running setup — the adapter injection is automated.

---

## Features

### 🏠 Home Dashboard

The entry point to your node. Displays:

- **Live peer health** — visual grid of connected peers with latency indicators, DID badges, and connection status
- **Block clock** — auto-incrementing block height representing mesh consensus ticks
- **Activity feed** — real-time stream of events across all subsystems (identity, networking, storage, ledger, AI, security)
- **Credits balance** — mesh credit ledger tracking earnings and spending across marketplace and tip transactions
- **CPU simulation** — node load indicator (real CPU stats in Electron via IPC)

Peers are discovered automatically via `BroadcastChannel` on page load. Each peer announcement includes a DID, public key, handle, and avatar. The home view updates in real time as peers join and leave.

---

### 💻 Code Editor

A fully functional collaborative code editor backed by a Merkle-DAG versioning system.

**Versioning:**
- Every save creates a signed DAG commit containing the file diff, parent CID, author DID, ECDSA P-256 signature, and a vector clock timestamp
- Commits are content-addressed — the CID is a SHA-256 hash of the commit data
- Commit history is rendered as a visual DAG tree with branch/merge visualization
- Conflict resolution uses deterministic LCA (Lowest Common Ancestor) merge with LWW-CRDT fallback

**Collaboration:**
- Real-time cursor sharing across peers via BroadcastChannel gossip
- Collab cursors rendered as colored overlays with peer handle labels
- File edits broadcast as signed delta messages; peers apply remote commits with `applyRemote()`

**Execution:**
- Code runs in a sandboxed `new Function()` context with op-count limiting (50,000 ops max) and a 3-second timeout
- Blocked globals: `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, `sessionStorage`, `indexedDB`, `document`, `window`, `parent`, `top`
- Output captured and displayed in an inline console panel

**Other editor features:**
- Multiple file tabs with CID-addressed storage
- Shared state panel — inspect live CRDT key-value store
- Signature audit log — verify every commit's ECDSA P-256 signature
- Share button — broadcast current file to the mesh

---

### 💬 Messenger

End-to-end encrypted group channels and direct messaging.

**Public channels:**
- Any peer can join named channels
- Messages broadcast over `BroadcastChannel` mesh with sender DID and signature
- Channel list, member roster, and message history all persisted in IndexedDB

**Encrypted channels:**
- AES-256-GCM symmetric key generated per channel
- Key shared via invite system — encoded as a base64 invite key the channel creator distributes
- All message content encrypted client-side before broadcast; only peers with the key can read

**Direct messages:**
- Routed over WebRTC DataChannel when a direct peer connection exists
- Falls back to mesh bus DM (less private but works cross-origin and cross-tab)
- DM threads identified by recipient DID

**File sharing:**
- Attach files from your local file system to any channel message
- Files CID-addressed and stored locally; CID shared over mesh so peers can fetch

**Channel features:**
- Create public or private channels
- Channel browser with search and join
- Invite key generation and copy-to-clipboard
- Member list with avatar, handle, and online status
- Notifications badge on toolbar

---

### 📡 Social Feed

A decentralized social platform — no algorithm, no moderation, no central server.

- **Posts** — text, code blocks, images, video attachments, and file links
- **Reactions** — likes and boosts, tracked locally and gossiped to peers
- **Tips** — send ◈ credits directly to a post author
- **Feed types** — All, Code Posts, Media — switchable via channel selector
- **Trending topics** — derived from hashtag frequency across recent posts
- **Suggested peers** — discovery panel for new nodes on the mesh
- **Compose modal** — rich post composer with media attachment support

Posts are signed with the author's ECDSA P-256 key and stored as DAG nodes. The feed is purely local — it shows posts from peers you are connected to in this mesh session.

---

### 📁 Files

A CID-addressed distributed file system.

- **Upload** — drag & drop or file picker; files hashed, CID computed, stored in IndexedDB
- **Encryption toggle** — files can be stored encrypted (AES-256-GCM) or plaintext
- **Grid / List view** — toggle between visual card layout and compact list
- **Preview** — inline previewer for images, text files, and code
- **Download** — retrieve any stored file by CID
- **Share** — broadcast a file's CID to a channel so peers can fetch it
- **Monetize** — list a file on the marketplace with a ◈ credit price
- **Folders** — create named folder groups for organization

In Electron mode, `ipfs add` is called on upload and the returned CID is used directly — files are addressable from any IPFS gateway.

---

### 🎬 Video

Peer-streamed video and live broadcasting.

- **Video library** — grid of uploaded peer videos with thumbnail, duration, and category
- **Category filter** — filter by Tech, Gaming, Music, Art, Education, and more
- **Player** — inline video player with play/pause, seek bar, volume, full-screen
- **Tip creator** — send ◈ credits to a video creator directly from the player
- **Upload** — drag & drop video file upload with title, description, and category metadata
- **Live streams** — simulated live stream cards with viewer counts and join buttons
- **Start stream** — broadcast a live stream from this node

---

### 🕸️ Network

Real-time visualization of the mesh topology.

- **Animated canvas** — nodes rendered as glowing dots with animated edges showing active connections; edge brightness reflects traffic intensity
- **Peer list** — scrollable list of all known peers with DID, handle, latency (ms), and connect/disconnect controls
- **Gossip log** — live stream of gossip messages propagating through the mesh with timestamps
- **Routing table** — shows next-hop routing for known DIDs with hop count and latency
- **Auto-discovery** — scans for peers on the local BroadcastChannel network and shows discovered nodes in a connection modal
- **Broadcast gossip** — manually push a gossip message to all peers

---

### 🛒 Marketplace

A peer-to-peer app economy with ◈ credit transactions.

- **Browse apps** — grid of community-published apps with name, description, rating, install count, author, and price
- **Category filter** — filter by Productivity, Dev Tools, Media, Finance, Games, and more
- **Install / Open** — install apps from the marketplace and launch them
- **Earnings dashboard** — track your credit balance, weekly earnings breakdown, and revenue by app
- **Publish** — submit your own app built in the App Builder to the marketplace
- **Monetization models** — choose between one-time purchase, subscription, or pay-per-use
- **Asset valuation** — request automated valuation of a published asset based on install and usage metrics

---

### 🔧 App Builder

A visual drag-and-drop interface for building apps that run on Sovereign Net OS.

**Component palette:**
- Text, Button, Input, Image, Container, Video, Chart, Map, and custom widgets

**Canvas:**
- Drag components onto a grid canvas, position freely
- Click to select, edit content inline, delete, or duplicate
- Component content syncs in real time via shared state

**Modes:**
- Design mode — place and arrange components
- Preview mode — renders the live app view
- Code mode — (planned) edit the generated component code directly

**Export:**
- Save locally, publish directly to the Marketplace, or share to the social feed

---

### ⌨️ Console / Terminal

A 30+ command terminal with real access to node internals.

**Identity & keys:**
```
whoami          — show your DID, handle, and public key
id              — show full identity object
pubkey          — print your base64 ECDSA P-256 public key
```

**DAG & storage:**
```
cid <text>      — compute the CID of any string
dag             — dump the full DAG store (all committed nodes)
dag-head <id>   — print the HEAD CID for a file
blocks          — list all raw blocks in the block store
cat <cid>       — read a block by CID
state           — dump the full CRDT shared state store
state-set <k> <v> — write a key-value pair to shared state (signed)
```

**Networking:**
```
peers           — list all currently known peers
ping <did>      — send a ping to a peer by DID
gossip <msg>    — broadcast a gossip message to all peers
discover        — trigger peer auto-discovery
```

**Execution:**
```
run <code>      — execute JavaScript in the sandboxed runtime
```

**Security:**
```
sig-log         — print the ECDSA P-256 signature audit log
audit           — run the RRTK security pattern scanner
```

**System:**
```
clear           — clear the terminal
replay          — replay the full event log
export-state    — export a JSON snapshot of all node state
help            — list all available commands
```

---

### 🪪 Identity

Sovereign identity — no username/password, no OAuth, no account.

- **DID** — a `did:svn:0x...` decentralized identifier derived from your ECDSA P-256 public key, generated on first launch and persisted in IndexedDB
- **Keypair** — ECDSA P-256 keypair generated using Web Crypto API; private key never leaves the device
- **Handle & avatar** — human-readable display name and emoji avatar; editable and broadcast to peers
- **Badges** — earned badges for node contributions (Early Node, Contributor, Validator, etc.)
- **Reputation score** — computed from mesh participation, signed commits, and peer interactions
- **Transaction history** — full ledger of all ◈ credit sends and receives
- **Export DID** — copy your DID document to clipboard for sharing
- **Key migration** — automatic detection and re-generation if a legacy key format is found (migrates stale keys to ECDSA P-256)

---

### ⚔️ Security Auditor

RRTK (Reentrancy, Replay, Trust, Keys) — a pattern-based vulnerability scanner for smart contracts and distributed protocol code.

**Detection patterns:**
- **Reentrancy** — detects cross-function reentrancy paths and missing mutex guards
- **Flash loan attacks** — identifies single-transaction balance manipulation vectors
- **Access control failures** — missing `onlyOwner`/`onlyRole` guards on state-mutating functions
- **Sybil resistance** — evaluates identity verification and economic stake requirements
- **Byzantine fault tolerance** — checks for insufficient quorum thresholds and missing fallback paths
- **Signature replay** — detects missing nonces and absent expiry checks on signed messages

**Workflow:**
1. Paste contract or protocol code into the audit input
2. Select which vulnerability patterns to scan (individual or all)
3. Run — results display with severity grade (Critical / High / Medium / Low), description, and line reference
4. Request asset valuation — automated scoring of your protocol's security posture

**Sybil cost meter:** Live display of the estimated cost to perform a Sybil attack on the current mesh, updated as peer count and stake parameters change.

---

### 🤖 AI Compute Node

Local AI inference via [Ollama](https://ollama.com) — no cloud, no API keys, no data leaving your machine.

**What it does:**
- Connects to a locally running Ollama instance at `http://localhost:11434`
- Lists available models and lets you select the active one
- Streams inference output token-by-token into the chat interface
- Stores every conversation turn as a signed DAG node (CID-addressed)
- Gossips AI output to mesh peers (optional)
- Accepts and runs inference jobs posted by remote peers (mesh jobs)

**System awareness:**
The AI is automatically given a system prompt populated with live node context on every session:
- Your node DID and node ID
- The active Ollama model
- Current peer count, block height, and pending mesh jobs
- Node capabilities (inference, dag-store, mesh-relay)

This means Ollama knows it's running inside a sovereign compute node and can respond to questions about your node's state.

**Setup:** See [AI Compute Node — Setup & Usage](#ai-compute-node--setup--usage) below.

---

## Architecture

Everything you see is actually happening in the browser — not mocked.

### Identity & Keys

```
ECDSA P-256 keypair  →  generated once via Web Crypto API
                 →  private key stored in IndexedDB (never transmitted)
                 →  public key broadcast in every peer announcement
DID              →  did:svn:0x<hex-derived-from-pubkey>
                 →  unique per device, persistent across sessions
```

### Networking & Mesh

```
Primary transport:  BroadcastChannel (same-origin multi-tab)
  — channel name: 'sovereign-net-v1'
  — message envelope: { type, from, payload, sig, ts }
  — all messages ECDSA P-256 signed by sender

Peer announcement:  broadcast on connect + every 15s (heartbeat)
Peer health check:  30s timeout — peers who miss 2 heartbeats are dropped
State sync:         LWW-CRDT gossip — every state write propagates to all peers

Secondary (Electron only):
  WebRTC DataChannels  →  direct peer-to-peer messaging
  IPFS pubsub          →  cross-machine mesh via Kubo daemon
```

### Storage & DAG

```
IndexedDB stores:
  blocks      →  raw CID-addressed byte blocks (SHA-256 hashed)
  dag         →  Merkle-DAG nodes (commits, file history)
  channels    →  channel metadata and membership
  messages    →  message history per channel
  files       →  file metadata + encrypted content
  identity    →  keypair, DID, profile

DAG node structure:
  { cid, parent, data, author, sig, ts, clock }
  — cid: SHA-256 hash of (parent + data + author + ts)
  — sig: ECDSA P-256 signature over cid by author's private key
  — clock: vector clock value for this author
```

### Crypto Layer

```
Signatures:     ECDSA P-256 (Web Crypto API) — all DAG commits, peer announcements, state writes
Encryption:     AES-256-GCM — channel messages, encrypted file storage
Key derivation: PBKDF2 (planned for channel key wrapping)
Hashing:        SHA-256 via SubtleCrypto — CID computation for all content
```

### State Sync (CRDT)

```
Algorithm:  Last-Write-Wins CRDT with vector clocks
Store:      key → { value, ts, clock, did, sig }
Merge rule: higher clock wins; ties broken by DID lexicographic order
Gossip:     every state write is broadcast as a signed STATE_UPDATE message
            peers apply remote updates via mergeRemote() on receipt
```

### Sandboxed Execution

```
Engine:     new Function() with explicit global whitelist
Limits:     50,000 op-count maximum, 3,000ms wall-clock timeout
Blocked:    fetch, XHR, WebSocket, localStorage, sessionStorage,
            indexedDB, document, window, parent, top, frames
Output:     console.log captured and returned as a string
```

### Security Engine (RRTK)

```
Input:      raw contract or protocol code (string)
Scanner:    regex + AST-pattern matching against vulnerability signatures
Patterns:   reentrancy, flash-loan, access-control, Sybil, Byzantine, sig-replay
Output:     { id, name, severity, description, lineRef }[]
Severity:   Critical → High → Medium → Low
Valuation:  composite score from pattern hits, weighted by severity
```

### AI Engine

```
Backend:        Ollama (local, http://localhost:11434)
Transport:      fetch() with ReadableStream for token-by-token streaming
Session state:  { id, messages[], cid, peers }
  — messages persisted as signed DAG nodes
  — session CID updated after each turn
Mesh jobs:      BroadcastChannel 'svn-ai-mesh-v1'
  — any peer can post a job: { prompt, model, temp, max_tokens }
  — nodes with 'Accept mesh jobs' enabled pick up and run inference
  — result gossiped back as AI_RESULT message
System prompt:  auto-populated with live node context on view activation
                and refreshed after each successful Ollama probe
```

---

## Electron / IPFS Integration

### How It Works

```
Renderer (index.html)
  └── window.ipfs.swarmPeers()
        └── contextBridge → preload.js
              └── ipcRenderer.invoke('ipfs', ...)
                    └── ipcMain.handle → main.js
                          └── http.request → localhost:5001 (Kubo API)
                                └── returns real peer data
```

All Kubo API calls go through `ipcMain` in the main process, bypassing CORS entirely. The renderer never touches `localhost:5001` directly.

### window.ipfs API

Available in Electron only (injected by `preload.js` via `contextBridge`):

```js
// Live peer list from the IPFS swarm
const { body } = await window.ipfs.swarmPeers();
// → { Peers: [{ Peer, Addr, Latency }, ...] }

// Add a file — get a real CID back
const { body } = await window.ipfs.add('hello.txt', new TextEncoder().encode('hi'));
// → { Hash: 'QmXxx...', Name: 'hello.txt', Size: '3' }

// Read any CID via the local gateway
const buf = await window.ipfs.cat('QmXxx...');

// Real pubsub — publish to a topic
await window.ipfs.pubsubPub('sovereign-net/general', btoa('hello network'));

// Subscribe to a topic
await window.ipfs.pubsubSub('sovereign-net/general', (msg) => { ... });

// Node identity
const { body } = await window.ipfs.id();
// → { ID: '12D3KooW...', Addresses: [...], PublicKey: '...' }

// Bandwidth stats
const { body } = await window.ipfs.statsBw();
// → { TotalIn, TotalOut, RateIn, RateOut }

// Repo stats
const { body } = await window.ipfs.repoStat();
// → { NumObjects, RepoSize, StorageMax }
```

### What ipfsAdapter.js Replaces

When running in Electron, `ipfsAdapter.js` is injected at runtime by `setup.sh` and automatically patches simulated subsystems with real Kubo equivalents:

| Simulated (Browser) | Real (Electron + Kubo) |
|---------------------|------------------------|
| `generatePeers(24)` — fake peer list | `swarm/peers` — live IPFS swarm nodes |
| `STATE.did` — random DID | `ipfs id` — your actual peer ID as `did:ipfs:12D3...` |
| File upload handler — IndexedDB only | `ipfs add` — real CID returned, pinned locally |
| `meshSendPublic()` — BroadcastChannel | `pubsub/pub` on `sovereign-net/<channelId>` |
| Home stats panel — simulated values | `stats/bw` + `repo/stat` — real bytes transferred |
| Console log | Kubo daemon stdout/stderr streamed via IPC |

The adapter wraps, not replaces. BroadcastChannel mesh stays active as a local fallback for same-machine tab communication.

### Daemon Lifecycle

`main.js` manages the full Kubo daemon lifecycle automatically:

1. Checks if a daemon is already running on `localhost:5001`
2. If not, locates the `ipfs` binary in order: `resources/bin/ipfs` (bundled) → common install paths → `$PATH`
3. Initializes the IPFS repo in `app.getPath('userData')/ipfs-repo` if it doesn't exist
4. Configures CORS headers and enables pubsub before starting
5. Streams daemon logs to the Console view via IPC events
6. On app quit, kills the daemon cleanly — but only if this process spawned it (won't kill a pre-existing daemon)

---

## Directory Layout

```
sovereign-net-os/
├── index.html                        ← The entire OS (single file, ~340 KB)
├── package.json                      ← Electron + electron-builder config
├── src/
│   ├── main.js                       ← Electron main process + Kubo lifecycle
│   ├── preload.js                    ← contextBridge — exposes window.ipfs to renderer
│   ├── ipfsAdapter.js                ← Patches simulated subsystems with live Kubo calls
│   ├── kernel.js                     ← DispatchKernel: typed errors, semantic DAG merge (injected by setup.sh)
│   ├── kernel-client.js              ← Client bridge to DispatchKernel (injected by setup.sh)
│   ├── kernel-persist.js             ← IndexedDB persistence layer
│   ├── kernel-replay.js              ← Event replay and state export
│   ├── kernel-sync.js                ← CRDT sync and gossip engine
│   └── kernel-adversarial-tests.js   ← Adversarial test suite (10 hostile scenarios)
├── scripts/
│   ├── setup.sh                      ← One-shot setup: deps + Kubo detection + adapter inject (also wires kernel modules)
│   └── index.html                    ← Kept in sync with root index.html (canonical source)
├── docs/
│   └── sovereign-net-os-docs.pdf     ← Full technical documentation
├── LICENSE-COMMUNITY                 ← Community use license
└── LICENSE-COMMERCIAL                ← Commercial use license
```

---

## Building for Distribution

```bash
# macOS — produces .dmg and .zip
npm run build:mac

# Windows — produces .exe NSIS installer
npm run build:win

# Linux — produces .AppImage and .deb
npm run build:linux

# All platforms in one command
npm run build:all
```

Output lands in `dist/`. Electron Builder handles code signing stubs, app icons, and installer generation.

> **Before building:** Add your app icons to the `assets/` directory. See `assets/README.md` for the required filenames and a quick generation guide. Builds will warn or fail if the icon files are absent.

### Bundling Kubo (Zero-Dependency Install)

To ship Kubo inside the app so users don't need to install it separately:

1. Download the Kubo binary for your target platform from https://github.com/ipfs/kubo/releases

2. Place it at:
   - `bin/ipfs` (macOS / Linux)
   - `bin/ipfs.exe` (Windows)

`bin/**/*` is already included in `package.json`'s `build.files` array. `main.js` checks `resources/bin/ipfs` first at runtime and uses it automatically if present.

---

## Console Command Reference

Full list of commands available in the ⌨️ Console view:

| Command | Description |
|---------|-------------|
| `whoami` | Print your DID, handle, avatar, and credit balance |
| `id` | Full identity object dump |
| `pubkey` | Print your base64-encoded ECDSA P-256 public key |
| `peers` | List all known peers with DID, handle, and latency |
| `ping <did>` | Send a ping message to a peer and await pong |
| `gossip <msg>` | Broadcast a raw gossip message to all peers |
| `discover` | Run auto-discovery scan for peers on the local mesh |
| `cid <text>` | Compute and print the SHA-256 CID of any input string |
| `dag` | Dump the full Merkle-DAG node store |
| `dag-head <fileId>` | Print the HEAD CID for a specific file |
| `blocks` | List all blocks in the local block store |
| `cat <cid>` | Read and print a block by CID |
| `state` | Dump the full CRDT shared state key-value store |
| `state-set <key> <val>` | Write a signed key-value pair to shared state |
| `run <code>` | Execute JavaScript in the sandboxed runtime |
| `sig-log` | Print the ECDSA P-256 signature audit log |
| `audit` | Run RRTK vulnerability scanner on current session code |
| `replay` | Replay the full event bus log from session start |
| `export-state` | Export a full JSON snapshot of node state to console |
| `clear` | Clear the terminal output |
| `help` | List all available commands with descriptions |

---

## AI Compute Node — Setup & Usage

The AI view connects to a locally running [Ollama](https://ollama.com) instance. Your prompts and responses never leave your machine.

### Install Ollama

```bash
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh

# Windows
# Download installer from https://ollama.com/download
```

### Start Ollama

```bash
ollama serve
```

Ollama listens on `http://localhost:11434` by default. The OS probes this endpoint when you open the AI view.

### Pull a Model

```bash
# Small and fast — good starting point
ollama pull llama3.2

# Code-focused
ollama pull codellama

# Larger, more capable
ollama pull mistral
ollama pull llama3.1:8b
```

### Using the AI View

1. Open the **AI** view from the dock
2. Click **⟳ Probe** — the OS detects Ollama and lists available models
3. Click a model to select it as active
4. Adjust **Temperature** (creativity) and **Max Tokens** (response length) as needed
5. The **System Prompt** field is auto-populated with your node's live context (DID, peers, model, etc.) — edit freely
6. Type a prompt and press **Enter** or click **▶ Run**

### Mesh Jobs

Any node on the mesh can post an inference job that gets picked up and run by another node:

- Enable **Accept mesh jobs** in the Node Capabilities panel to accept jobs from peers
- Enable **Share outputs** to gossip your inference results back to the mesh
- Click **⬡ Mesh** on any prompt to broadcast it as a job instead of running locally
- The job queue panel shows pending and completed jobs with status, model, and result

### Session Storage

Every prompt and response is stored as a signed DAG node. The **SESSION CID** shown at the top of the chat panel is the CID of the last committed turn. Enable **store in DAG** (checked by default) to persist conversation history across views.

---

## Patch Notes

### v0.1.0 — Initial release

Core OS, all views, BroadcastChannel mesh, DAG editor, encrypted messenger, social feed, file system, marketplace, app builder, terminal, identity, RRTK security auditor, AI compute node.

### v0.1.1 — Ollama System Awareness Fix

**Problem:** The Ollama AI engine was not system-aware. The system prompt textarea was blank by default. `aiSend()` only included a system message `if (sysprompt)` — so Ollama received no context about the node it was running on.

**Fix:** Added `aiInjectSystemPrompt(forceRefresh)` — a function that reads live node state (DID, node ID, peer count, block height, pending jobs, active model) and writes it into the system prompt textarea automatically. It is called:
- When the AI view is first activated (if the field is empty)
- After every successful Ollama probe (with `forceRefresh=true`) so the model name is always current

The flag prevents overwriting prompts the user has typed manually, but the post-probe refresh ensures stale auto-generated prompts are updated when a new model is selected.

---

## Roadmap

- [ ] **IPNS** — publish your handle/profile to the DHT for persistent addressing
- [ ] **Real DAG commits over IPFS** — editor commits stored as genuine IPFS objects, not just IndexedDB
- [ ] **OrbitDB** — persistent, replicated message history across nodes
- [ ] **libp2p WebRTC** — direct browser ↔ Electron peer connections without relay
- [ ] **Bundled Kubo binary** — zero-dependency desktop install, no separate IPFS setup
- [ ] **WASM Kubo** — run the IPFS node directly in the browser tab, no Electron required
- [ ] **Mobile PWA** — service worker mesh for iOS and Android
- [ ] **DAG-native file system** — replace IndexedDB file storage with IPFS MFS
- [ ] **Kernel hot-reload** — update the kernel module without reloading the page
- [ ] **Multi-device identity** — DID key sync across devices via IPNS or QR pairing

---

## License

- **Community use** — see `LICENSE-COMMUNITY`
- **Commercial use** — see `LICENSE-COMMERCIAL`

For licensing inquiries, refer to the terms in each license file.

---

> *You are not using the internet. You are the internet.*
>
> Built as a single `index.html` to prove it can be done.
