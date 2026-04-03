/**
 * DIK KERNEL - Deterministic Interaction Kernel
 * Spatial runtime for deterministic hit testing
 * 
 * Core guarantees:
 * - No DOM-based hit testing
 * - Structural depth ordering
 * - One pointer -> one target per frame
 * - Frame pipeline is fixed and replayable
 */

import { layout, layoutTree } from './layout.js';
import { hitTest } from './hit-test.js';
import { PointerManager } from './pointer.js';

// Logical clock (injected, no Date.now())
let logicalTick = 0;
let clockAdapter = null;

// Root of the spatial tree
let rootNode = null;

// Frame state
let frameInProgress = false;
let pendingInputs = [];
let frameIntents = [];

// Intent callback
let onIntent = null;

// Pointer manager
const pointerManager = new PointerManager();

/**
 * KNode - Kernel Node structure
 * Represents an element in the spatial tree
 */
export class KNode {
  constructor(id, options = {}) {
    this.id = id;
    this.parent = null;
    this.children = [];
    
    // Local bounds (relative to parent)
    this.local = {
      x: options.x || 0,
      y: options.y || 0,
      w: options.w || 0,
      h: options.h || 0,
    };
    
    // World bounds (computed during layout)
    this.world = { x: 0, y: 0, w: 0, h: 0 };
    
    // Structural ordering
    this.depth = 0;
    this.structuralIndex = 0;
    
    // Event handlers
    this.handlers = options.handlers || {};
    
    // Metadata
    this.data = options.data || {};
    this.interactive = options.interactive !== false;
  }
  
  /**
   * Add child node
   */
  addChild(node) {
    node.parent = this;
    node.depth = this.depth + 1;
    this.children.push(node);
    return node;
  }
  
  /**
   * Remove child node
   */
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index !== -1) {
      this.children.splice(index, 1);
      node.parent = null;
    }
  }
  
  /**
   * Find node by ID in subtree
   */
  findById(id) {
    if (this.id === id) return this;
    for (const child of this.children) {
      const found = child.findById(id);
      if (found) return found;
    }
    return null;
  }
  
  /**
   * Check if point is within world bounds
   */
  containsPoint(x, y) {
    return (
      x >= this.world.x &&
      x < this.world.x + this.world.w &&
      y >= this.world.y &&
      y < this.world.y + this.world.h
    );
  }
}

/**
 * Initialize the DIK
 */
export function initDIK(options = {}) {
  clockAdapter = options.clockAdapter || (() => Date.now());
  onIntent = options.onIntent || null;
  
  // Create root node
  rootNode = new KNode('root', {
    x: 0,
    y: 0,
    w: options.width || 1920,
    h: options.height || 1080,
  });
  
  logicalTick = 0;
  pendingInputs = [];
  frameIntents = [];
  
  console.log('[DIK] Initialized');
  return rootNode;
}

/**
 * Get root node
 */
export function getRoot() {
  return rootNode;
}

/**
 * Set intent callback
 */
export function setIntentHandler(handler) {
  onIntent = handler;
}

/**
 * Queue input event for next frame
 */
export function queueInput(input) {
  pendingInputs.push({
    ...input,
    queuedAt: logicalTick,
  });
}

/**
 * Run a single frame
 * Pipeline: INPUT -> UPDATE -> LAYOUT -> HIT TEST -> TARGET LOCK -> INTENT EMIT -> COMMIT
 */
export function runFrame() {
  if (frameInProgress) {
    console.warn('[DIK] Frame already in progress');
    return [];
  }
  
  frameInProgress = true;
  frameIntents = [];
  
  try {
    // 1. INPUT - Collect pending inputs
    const inputs = [...pendingInputs];
    pendingInputs = [];
    
    // 2. UPDATE - Apply any state updates (future: animation ticks)
    // Currently no-op
    
    // 3. LAYOUT - Compute world positions
    if (rootNode) {
      layoutTree(rootNode);
    }
    
    // 4-6. Process each input through HIT TEST -> TARGET LOCK -> INTENT EMIT
    for (const input of inputs) {
      processInput(input);
    }
    
    // 7. COMMIT - Increment tick
    logicalTick++;
    
    // Emit intents
    if (onIntent && frameIntents.length > 0) {
      for (const intent of frameIntents) {
        onIntent(intent);
      }
    }
    
    return frameIntents;
    
  } finally {
    frameInProgress = false;
  }
}

/**
 * Process single input through HIT TEST -> TARGET LOCK -> INTENT EMIT
 */
function processInput(input) {
  const { type, pointerId, x, y, payload } = input;
  
  switch (type) {
    case 'pointerdown': {
      // Hit test to find target
      const target = hitTest(rootNode, x, y);
      if (!target) return;
      
      // Lock pointer to target
      pointerManager.lock(pointerId, target.id);
      
      // Emit intent
      emitIntent('ui.pointerdown', target, { x, y, pointerId, ...payload });
      break;
    }
    
    case 'pointermove': {
      // Get locked target (or hit test if not locked)
      const lockedTargetId = pointerManager.getLockedTarget(pointerId);
      let target;
      
      if (lockedTargetId) {
        target = rootNode.findById(lockedTargetId);
      } else {
        target = hitTest(rootNode, x, y);
      }
      
      if (!target) return;
      
      emitIntent('ui.pointermove', target, { x, y, pointerId, ...payload });
      break;
    }
    
    case 'pointerup': {
      const lockedTargetId = pointerManager.getLockedTarget(pointerId);
      const target = lockedTargetId 
        ? rootNode.findById(lockedTargetId)
        : hitTest(rootNode, x, y);
      
      // Unlock pointer
      pointerManager.unlock(pointerId);
      
      if (!target) return;
      
      emitIntent('ui.pointerup', target, { x, y, pointerId, ...payload });
      break;
    }
    
    case 'pointercancel': {
      const lockedTargetId = pointerManager.getLockedTarget(pointerId);
      pointerManager.unlock(pointerId);
      
      if (lockedTargetId) {
        const target = rootNode.findById(lockedTargetId);
        if (target) {
          emitIntent('ui.pointercancel', target, { pointerId, ...payload });
        }
      }
      break;
    }
    
    case 'keydown':
    case 'keyup': {
      // Key events go to focused node (or root)
      const target = rootNode; // TODO: focus management
      emitIntent(`ui.${type}`, target, payload);
      break;
    }
    
    default:
      console.warn(`[DIK] Unknown input type: ${type}`);
  }
}

/**
 * Emit intent to frame collection
 */
function emitIntent(type, target, payload = {}) {
  const intent = {
    type,
    target: target.id,
    payload,
    tick: logicalTick,
  };
  
  frameIntents.push(intent);
  
  // Call handler on target if exists
  const handlerName = type.replace('ui.', 'on');
  if (target.handlers[handlerName]) {
    target.handlers[handlerName](intent);
  }
}

/**
 * Get current logical tick
 */
export function getTick() {
  return logicalTick;
}

/**
 * Set logical tick (for replay)
 */
export function setTick(tick) {
  logicalTick = tick;
}

/**
 * Serialize tree for debugging
 */
export function serializeTree(node = rootNode, depth = 0) {
  if (!node) return null;
  
  return {
    id: node.id,
    depth: node.depth,
    local: { ...node.local },
    world: { ...node.world },
    children: node.children.map(c => serializeTree(c, depth + 1)),
  };
}

export default {
  KNode,
  initDIK,
  getRoot,
  setIntentHandler,
  queueInput,
  runFrame,
  getTick,
  setTick,
  serializeTree,
};
