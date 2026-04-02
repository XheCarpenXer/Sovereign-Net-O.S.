
# SOVEREIGN NET OS — Decentralized Internet Node

**A fully functional, single-file decentralized operating system that runs entirely in your browser.**

`index.html` is not just a demo — it is a **complete sovereign node** simulating the future internet: P2P mesh networking, DAG-based versioning, CID-addressed storage, end-to-end encrypted messaging, collaborative code editing, decentralized social feed, video streaming, app marketplace, drag-and-drop app builder, and real in-browser security auditing.

Open it. You are the node.

---

## ✨ What is Sovereign Net OS?

Sovereign Net OS is a **self-contained decentralized operating system** designed to show what the internet could look like when every user runs their own sovereign node.

- No central servers  
- No cloud providers  
- No single point of failure  
- Everything runs peer-to-peer in the browser

It uses real browser primitives (BroadcastChannel for mesh, IndexedDB for persistence, Web Crypto for signing/encryption, Canvas for network visualization, etc.) to create an immersive experience that feels like a real OS.

---

## 🚀 Quick Start

1. **Download** `index.html` (the entire OS is one file — 287 KB)
2. **Open it** in any modern browser (Chrome/Edge/Firefox recommended)
3. **Open multiple tabs** — they automatically discover each other via `BroadcastChannel` and form a live mesh network
4. Start using the OS immediately

**Pro tip:** Open 3–4 tabs side-by-side to instantly see real-time P2P collaboration, gossip, and mesh effects.

---

## 🧭 Core Views & Features

| Icon | View | Key Features |
|------|------|--------------|
| 🏠 | **Home** | Live stats, event stream, activity feed, node health |
| 💻 | **Code Editor** | Real DAG versioning, Ed25519 commits, real-time collab cursors, sandboxed execution |
| 💬 | **Messenger** | Public + private encrypted channels, DMs, file sharing |
| 📡 | **Social Feed** | Decentralized posts, likes, boosts, trending topics |
| 📁 | **File System** | CID-addressed storage, drag & drop, encryption |
| 🎬 | **Video Node** | Peer-streamed videos, live streaming simulation |
| 🕸️ | **Network** | Live mesh canvas, peer list, gossip log |
| 🛒 | **Marketplace** | Buy/sell apps, monetization, earnings dashboard |
| 🔧 | **App Builder** | Drag-and-drop component builder with live preview |
| ⌨️ | **Console** | Full terminal with 30+ real commands (`dag`, `cid`, `state-set`, `run`, etc.) |
| 🪪 | **Identity** | DID management, keys, badges, reputation |
| ⚔️ | **Security** | Built-in **RRTK** (Real-time Runtime Toolkit) security auditor for smart-contract-style workflows |

---

## 🔧 Technical Architecture (Real, Not Fake)

- **Identity**: Ed25519 + DID generation (persistent across sessions)
- **Networking**: `BroadcastChannel` mesh (real multi-tab P2P) + simulated WebRTC
- **Storage**: IndexedDB (`blocks`, `dag`, `channels`, `messages`, `files`)
- **Versioning**: Full Merkle-DAG with signed commits and clock
- **Crypto**: Real Web Crypto API (signatures, AES-GCM channel keys)
- **State**: LWW-CRDT gossip for shared collaborative state
- **Execution**: Sandboxed `new Function()` with op/time metering
- **Security Engine**: RRTK — pattern-based vulnerability scanner (reentrancy, flash-loan, access control, Sybil, Byzantine, etc.)
- **Valuation**: On-chain style asset valuation engine

Everything you see happening (commits, messages, peer discovery, file CIDs, signatures) is **actually happening** in the browser.

---

## 🛠️ How to Use the Most Powerful Parts

### 1. Collaborative Code Editor
- Switch to **Editor** view
- Type in the textarea → changes sync instantly across tabs
- Click **⊕ Commit** → creates real signed DAG node
- Open multiple tabs to see live collab cursors

### 2. Real Mesh Networking
- Open 2+ tabs
- Go to **Network** view
- Watch the canvas animate live peer connections
- Use **Auto-Discover** and **Gossip** buttons

### 3. Security Testing (RRTK)
- Go to **Security Testing** (rail icon ⚔️)
- Paste any workflow JSON (or load example)
- Run full attack pattern suite
- Get instant vulnerability report + grade (A+ to F)

### 4. Terminal (`⌨️`)
- Type `help` for full command list
- Try: `cid hello`, `state-set test 42`, `dag`, `run`, `blocks`, `sig-log`

---

## 🎯 Philosophy

This is not just a UI mockup.

It is a **working prototype of a sovereign node** that proves:

> Every user can own their own internet — code, identity, data, money, and compute — without asking permission from any corporation.

---

## 📄 Project Status

**Current Version**: v1.0 (single-file proof of concept)  
**License**: MIT (feel free to fork, modify, and build the real thing)  
**Made as**: A love letter to the decentralized web

---

## 🌐 Future Vision

This HTML is the seed.

The real Sovereign Net OS would run as:
- A native desktop app (Tauri/Electron)
- A progressive web app installable on any device
- A full node with WebRTC + libp2p + IPFS
- A foundation for truly decentralized applications

---

**You are not using the internet.**

**You *are* the internet.**

Welcome to Sovereign Net OS.

— Built as a single `index.html` to prove it can be done.
