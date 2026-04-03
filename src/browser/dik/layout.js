/**
 * DIK LAYOUT - Deterministic layout computation
 * Computes world positions from local positions
 */

/**
 * Layout a single node relative to parent world position
 */
export function layout(node, parentWorld = { x: 0, y: 0 }) {
  // Compute world position
  node.world.x = parentWorld.x + node.local.x;
  node.world.y = parentWorld.y + node.local.y;
  node.world.w = node.local.w;
  node.world.h = node.local.h;
}

/**
 * Layout entire tree recursively
 * Assigns structural indices for deterministic ordering
 */
export function layoutTree(node, parentWorld = { x: 0, y: 0 }, indexRef = { value: 0 }) {
  // Assign structural index (depth-first order)
  node.structuralIndex = indexRef.value++;
  
  // Compute world bounds
  layout(node, parentWorld);
  
  // Layout children
  for (const child of node.children) {
    layoutTree(child, node.world, indexRef);
  }
}

/**
 * Compute bounding box of node and all descendants
 */
export function computeBounds(node) {
  let minX = node.world.x;
  let minY = node.world.y;
  let maxX = node.world.x + node.world.w;
  let maxY = node.world.y + node.world.h;
  
  for (const child of node.children) {
    const childBounds = computeBounds(child);
    minX = Math.min(minX, childBounds.x);
    minY = Math.min(minY, childBounds.y);
    maxX = Math.max(maxX, childBounds.x + childBounds.w);
    maxY = Math.max(maxY, childBounds.y + childBounds.h);
  }
  
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  };
}

/**
 * Check if node is visible (has non-zero area)
 */
export function isVisible(node) {
  return node.world.w > 0 && node.world.h > 0;
}

export default {
  layout,
  layoutTree,
  computeBounds,
  isVisible,
};
