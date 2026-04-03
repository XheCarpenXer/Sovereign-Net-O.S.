/**
 * VIEW RENDERER - DOM projection layer
 * DOM is write-only - no layout reads allowed
 * 
 * Allowed:
 * - Apply transforms
 * - Display state
 * 
 * Forbidden:
 * - Layout reads (getBoundingClientRect)
 * - Event targeting logic
 * - State mutation
 */

/**
 * Renderer - projects KNode tree to DOM
 */
export class Renderer {
  constructor(container) {
    this.container = container;
    this.elements = new Map(); // KNode id -> DOM element
  }
  
  /**
   * Render entire tree to DOM
   */
  render(rootNode) {
    // Clear existing
    this.clear();
    
    // Render tree
    this._renderNode(rootNode, this.container);
  }
  
  /**
   * Render single node and children
   */
  _renderNode(node, parentEl) {
    // Create element
    const el = document.createElement('div');
    el.id = `dik-${node.id}`;
    el.className = 'dik-node';
    el.dataset.dikId = node.id;
    el.dataset.depth = node.depth;
    
    // Apply world position as transform (no layout queries)
    this._applyTransform(el, node);
    
    // Apply data attributes
    if (node.data) {
      for (const [key, value] of Object.entries(node.data)) {
        if (typeof value === 'string' || typeof value === 'number') {
          el.dataset[key] = value;
        }
      }
    }
    
    // Store reference
    this.elements.set(node.id, el);
    
    // Append to parent
    parentEl.appendChild(el);
    
    // Render children
    for (const child of node.children) {
      this._renderNode(child, el);
    }
  }
  
  /**
   * Apply transform from KNode world position
   * Uses transform instead of top/left for performance
   */
  _applyTransform(el, node) {
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.width = `${node.world.w}px`;
    el.style.height = `${node.world.h}px`;
    el.style.transform = `translate(${node.world.x}px, ${node.world.y}px)`;
    el.style.willChange = 'transform';
  }
  
  /**
   * Update single node position
   */
  updateNode(node) {
    const el = this.elements.get(node.id);
    if (el) {
      this._applyTransform(el, node);
    }
  }
  
  /**
   * Update all nodes
   */
  updateAll(rootNode) {
    this._updateNodeRecursive(rootNode);
  }
  
  _updateNodeRecursive(node) {
    this.updateNode(node);
    for (const child of node.children) {
      this._updateNodeRecursive(child);
    }
  }
  
  /**
   * Clear all rendered elements
   */
  clear() {
    this.elements.clear();
    this.container.innerHTML = '';
  }
  
  /**
   * Get DOM element for KNode
   */
  getElement(nodeId) {
    return this.elements.get(nodeId);
  }
  
  /**
   * Apply visual state to node
   */
  applyState(nodeId, state) {
    const el = this.elements.get(nodeId);
    if (!el) return;
    
    // Apply CSS classes
    if (state.classes) {
      el.className = `dik-node ${state.classes.join(' ')}`;
    }
    
    // Apply inline styles
    if (state.styles) {
      for (const [prop, value] of Object.entries(state.styles)) {
        el.style[prop] = value;
      }
    }
    
    // Apply text content
    if (state.text !== undefined) {
      el.textContent = state.text;
    }
  }
}

/**
 * Create input adapter that converts DOM events to DIK inputs
 * DOM events -> DIK queueInput()
 */
export function createInputAdapter(dikInstance, targetEl) {
  const getPointerId = (e) => e.pointerId || 0;
  
  const handlers = {
    pointerdown: (e) => {
      dikInstance.queueInput({
        type: 'pointerdown',
        pointerId: getPointerId(e),
        x: e.clientX,
        y: e.clientY,
        button: e.button,
      });
    },
    
    pointermove: (e) => {
      dikInstance.queueInput({
        type: 'pointermove',
        pointerId: getPointerId(e),
        x: e.clientX,
        y: e.clientY,
      });
    },
    
    pointerup: (e) => {
      dikInstance.queueInput({
        type: 'pointerup',
        pointerId: getPointerId(e),
        x: e.clientX,
        y: e.clientY,
        button: e.button,
      });
    },
    
    pointercancel: (e) => {
      dikInstance.queueInput({
        type: 'pointercancel',
        pointerId: getPointerId(e),
      });
    },
    
    keydown: (e) => {
      dikInstance.queueInput({
        type: 'keydown',
        payload: {
          key: e.key,
          code: e.code,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
        },
      });
    },
    
    keyup: (e) => {
      dikInstance.queueInput({
        type: 'keyup',
        payload: {
          key: e.key,
          code: e.code,
        },
      });
    },
  };
  
  // Attach handlers
  for (const [event, handler] of Object.entries(handlers)) {
    targetEl.addEventListener(event, handler);
  }
  
  // Return cleanup function
  return () => {
    for (const [event, handler] of Object.entries(handlers)) {
      targetEl.removeEventListener(event, handler);
    }
  };
}

export default {
  Renderer,
  createInputAdapter,
};
