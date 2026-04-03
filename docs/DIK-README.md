# DIK (Deterministic Interaction Kernel) Integration

## Overview

The Sovereign OS now includes a complete **DIK (Deterministic Interaction Kernel)** implementation that provides deterministic, replayable UI interactions. This integration bridges the gap between user interface events and the underlying transaction kernel.

## What is DIK?

DIK is a spatial runtime for deterministic hit testing with the following core guarantees:

- **No DOM-based hit testing** - Layout is computed inside the kernel
- **Pointer lock invariant** - One pointer → one target per frame
- **Deterministic frame pipeline** - INPUT → UPDATE → LAYOUT → HIT TEST → TARGET LOCK → INTENT EMIT → COMMIT
- **Replayable interactions** - All UI interactions become signed, replayable transactions

## Architecture

```
[ User Input ] 
      ↓
[ Input Adapter ] (DOM events → DIK inputs)
      ↓
[ DIK Kernel ] (Deterministic frame pipeline)
      ↓
[ Interaction Bridge ] (Intents → Transactions)
      ↓
[ State Kernel ] (Apply & record)
      ↓
[ View Renderer ] (State → DOM updates)
```

## Module Structure

```
src/
├── core/
│   ├── config.js          # System configuration (ports, paths, limits)
│   ├── crypto.js          # ECDSA P-256, AES-GCM-256, SHA-256, PBKDF2
│   └── storage.js         # Filesystem persistence + shard store
├── browser/
│   ├── dik/
│   │   ├── kernel.js      # DIK spatial runtime
│   │   ├── layout.js      # Deterministic layout computation
│   │   ├── hit-test.js    # Deterministic hit testing
│   │   └── pointer.js     # Pointer lock management
│   ├── bridge/
│   │   └── interaction-bridge.js  # DIK → Transaction bridge
│   └── view/
│       └── renderer.js    # DOM projection (write-only)
└── dik-index.js           # Main exports
```

## Core Modules

### 1. Config (src/core/config.js)

System-wide configuration:

```javascript
import { CONFIG } from './src/core/config.js';

// Network ports
CONFIG.tcpPort        // 8567
CONFIG.wsPort         // 8569
CONFIG.mdnsPort       // 5353

// Timeouts
CONFIG.pingInterval   // 30000ms
CONFIG.peerTimeout    // 90000ms

// Storage
CONFIG.dataDir        // ~/.sovereign-os
```

### 2. Crypto (src/core/crypto.js)

Cryptographic primitives:

```javascript
import * as Crypto from './src/core/crypto.js';

// Key generation
const { publicKey, privateKey, pubHex, privHex } = Crypto.generateKeyPair();

// Signing
const signature = Crypto.sign(data, privateKey);
const isValid = Crypto.verify(data, signature, publicKey);

// Encryption
const encrypted = Crypto.encrypt(plaintext, key);
const decrypted = Crypto.decrypt(encrypted, key);

// Hashing
const hash = Crypto.sha256(data);

// DID generation
const did = Crypto.generateDID(pubHex);  // did:sos:xxxxx
```

### 3. Storage (src/core/storage.js)

Persistent storage operations:

```javascript
import * as Storage from './src/core/storage.js';

// Initialize
Storage.initStorage();

// Identity
const identity = Storage.loadIdentity();
Storage.saveIdentity({ did, pubHex, privHex });

// Event log
const events = Storage.loadEventLog();
Storage.appendEvent(event);

// State
const state = Storage.loadState();
Storage.saveState(newState);

// Shards
Storage.writeShard(shardId, data);
const shard = Storage.readShard(shardId);
```

## DIK Components

### 4. DIK Kernel (src/browser/dik/kernel.js)

The core spatial runtime:

```javascript
import { initDIK, queueInput, runFrame, getRoot } from './src/browser/dik/kernel.js';

// Initialize
const root = initDIK({
  width: 1920,
  height: 1080,
  onIntent: (intent) => {
    console.log('Intent:', intent);
  }
});

// Create spatial tree
import { KNode } from './src/browser/dik/kernel.js';

const button = new KNode('btn1', {
  x: 100,
  y: 100,
  w: 200,
  h: 50,
  handlers: {
    onpointerdown: (intent) => {
      console.log('Button clicked!');
    }
  }
});

root.addChild(button);

// Queue input
queueInput({
  type: 'pointerdown',
  pointerId: 1,
  x: 150,
  y: 125
});

// Run frame (processes all pending inputs)
const intents = runFrame();
```

### 5. Layout System (src/browser/dik/layout.js)

Deterministic layout computation:

```javascript
import { layoutTree } from './src/browser/dik/layout.js';

// Compute world positions
layoutTree(rootNode);

// Now all nodes have .world coordinates:
// node.world.x, node.world.y, node.world.w, node.world.h
```

### 6. Hit Testing (src/browser/dik/hit-test.js)

Deterministic spatial queries:

```javascript
import { hitTest } from './src/browser/dik/hit-test.js';

// Find node at point
const target = hitTest(rootNode, mouseX, mouseY);
if (target) {
  console.log('Hit:', target.id);
}
```

### 7. Interaction Bridge (src/browser/bridge/interaction-bridge.js)

Converts DIK intents to kernel transactions:

```javascript
import { InteractionBridge } from './src/browser/bridge/interaction-bridge.js';

const bridge = new InteractionBridge(kernel, {
  onTransaction: (tx) => {
    console.log('Transaction:', tx);
  }
});

// Wire up to DIK
setIntentHandler((intent) => bridge.handle(intent));
```

### 8. View Renderer (src/browser/view/renderer.js)

Projects KNode tree to DOM (write-only):

```javascript
import { Renderer, createInputAdapter } from './src/browser/view/renderer.js';

const renderer = new Renderer(containerEl);

// Render tree
renderer.render(rootNode);

// Update on frame
runFrame();
renderer.updateAll(rootNode);

// Set up input adapter
const cleanup = createInputAdapter(dikInstance, containerEl);
```

## Complete Example

Here's a complete example integrating all components:

```javascript
import { 
  initDIK, 
  KNode, 
  queueInput, 
  runFrame, 
  setIntentHandler 
} from './src/browser/dik/kernel.js';
import { Renderer, createInputAdapter } from './src/browser/view/renderer.js';
import { InteractionBridge } from './src/browser/bridge/interaction-bridge.js';

// 1. Initialize DIK
const root = initDIK({ width: 800, height: 600 });

// 2. Build spatial tree
const app = new KNode('app', { x: 0, y: 0, w: 800, h: 600 });
const button = new KNode('submit-btn', {
  x: 300,
  y: 250,
  w: 200,
  h: 100,
  data: { text: 'Click me!' }
});
app.addChild(button);
root.addChild(app);

// 3. Set up renderer
const container = document.getElementById('dik-container');
const renderer = new Renderer(container);
renderer.render(root);

// 4. Set up interaction bridge
const bridge = new InteractionBridge(null, {
  onTransaction: (tx) => {
    console.log('Transaction:', tx);
    // Apply to state, emit to network, etc.
  }
});

setIntentHandler((intent) => {
  console.log('Intent:', intent);
  bridge.handle(intent);
});

// 5. Wire up DOM events
const cleanup = createInputAdapter({ queueInput }, container);

// 6. Run frame loop
function loop() {
  const intents = runFrame();
  if (intents.length > 0) {
    renderer.updateAll(root);
  }
  requestAnimationFrame(loop);
}
loop();
```

## Integration with Existing Kernel

To integrate DIK with the existing Sovereign OS kernel:

1. **Import DIK modules** in your main kernel file
2. **Initialize DIK** alongside the existing kernel
3. **Bridge intents** to kernel transactions via `InteractionBridge`
4. **Render state** using the view renderer

Example integration:

```javascript
// In src/kernel.js or src/main.js
import DIK from './dik-index.js';

// Initialize both kernels
const stateKernel = new SovereignKernel();
const dikRoot = DIK.kernel.initDIK({ 
  width: window.innerWidth, 
  height: window.innerHeight 
});

// Bridge them together
const bridge = new DIK.bridge.InteractionBridge(stateKernel);
DIK.kernel.setIntentHandler((intent) => bridge.handle(intent));
```

## Frame Pipeline

Every frame follows this exact sequence:

1. **INPUT** - Collect all pending inputs from queue
2. **UPDATE** - Apply state updates (animations, physics, etc.)
3. **LAYOUT** - Compute world positions for all nodes
4. **HIT TEST** - Find target node for each input
5. **TARGET LOCK** - Lock pointers to targets
6. **INTENT EMIT** - Generate intent records
7. **COMMIT** - Increment logical tick

This pipeline is **deterministic** and **replayable** - given the same inputs and initial state, you'll always get the same output.

## Key Benefits

1. **Deterministic** - Same input → same output, always
2. **Replayable** - Record and replay entire sessions
3. **Testable** - Unit test UI interactions
4. **Auditable** - Every interaction is a signed transaction
5. **Mesh-native** - Intents sync across peers
6. **Separation of concerns** - UI logic ≠ state logic

## Configuration

All DIK settings are in `src/core/config.js`:

```javascript
export const CONFIG = {
  PROTOCOL_VERSION: 'sos/9.1',
  tcpPort: 8567,
  wsPort: 8569,
  maxBrowserPeers: 100,
  // ... etc
};
```

## Storage Locations

DIK data is stored in `~/.sovereign-os/`:

```
~/.sovereign-os/
├── identity.json       # DID + keys
├── event-log.json      # All events
├── state.json          # Latest state snapshot
├── ledger-blocks.json  # Ledger blocks
├── known-peers.json    # Peer list
├── shard-index.json    # Shard metadata
└── shards/             # Event shards
    ├── shard_001.json
    └── shard_002.json
```

## Dependencies

The DIK integration adds:

- **ws** (^8.16.0) - WebSocket support for mesh networking

## Next Steps

1. Review the module documentation in each file
2. Run the complete example to see DIK in action
3. Integrate with your existing UI components
4. Set up mesh networking with the WebSocket hub
5. Test deterministic replay with recorded intent logs

## License

Same as Sovereign OS - dual licensed under Community and Commercial licenses.
