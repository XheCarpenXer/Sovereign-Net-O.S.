/**
 * SOVEREIGN OS - DIK (Deterministic Interaction Kernel) Integration
 * 
 * This module provides the complete DIK system for deterministic UI interactions.
 * All UI intents are converted to signed, replayable transactions.
 */

// Core modules
export { CONFIG } from './core/config.js';
export * as Crypto from './core/crypto.js';
export * as Storage from './core/storage.js';

// DIK kernel
export { 
  KNode, 
  initDIK, 
  getRoot, 
  setIntentHandler, 
  queueInput, 
  runFrame, 
  getTick, 
  setTick, 
  serializeTree 
} from './browser/dik/kernel.js';

// DIK layout
export { 
  layout, 
  layoutTree, 
  computeBounds, 
  isVisible 
} from './browser/dik/layout.js';

// DIK hit testing
export { 
  hitTest, 
  hitTestAll, 
  hitTestWithPriority, 
  pointInTree 
} from './browser/dik/hit-test.js';

// DIK pointer management
export { PointerManager } from './browser/dik/pointer.js';

// Interaction bridge
export { 
  InteractionBridge, 
  createNetworkBridge 
} from './browser/bridge/interaction-bridge.js';

// View renderer
export { 
  Renderer, 
  createInputAdapter 
} from './browser/view/renderer.js';

// Re-export defaults
import dikKernel from './browser/dik/kernel.js';
import dikLayout from './browser/dik/layout.js';
import dikHitTest from './browser/dik/hit-test.js';
import dikPointer from './browser/dik/pointer.js';
import interactionBridge from './browser/bridge/interaction-bridge.js';
import viewRenderer from './browser/view/renderer.js';

export const DIK = {
  kernel: dikKernel,
  layout: dikLayout,
  hitTest: dikHitTest,
  pointer: dikPointer,
  bridge: interactionBridge,
  renderer: viewRenderer,
};

export default DIK;
