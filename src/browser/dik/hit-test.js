/**
 * DIK HIT-TEST - Deterministic hit testing
 * 
 * Rules:
 * 1. Traverse tree depth-first
 * 2. Children evaluated before parents
 * 3. Structural order > visual stacking
 * 4. First match wins
 */

/**
 * Hit test a point against the spatial tree
 * Returns the deepest interactive node containing the point
 */
export function hitTest(node, x, y) {
  // Check children first (depth-first, reverse order for top-most first)
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i];
    const hit = hitTest(child, x, y);
    if (hit) return hit;
  }
  
  // Then check self
  if (node.interactive && node.containsPoint(x, y)) {
    return node;
  }
  
  return null;
}

/**
 * Get all nodes containing a point (for debugging)
 */
export function hitTestAll(node, x, y, results = []) {
  // Check children first
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i];
    hitTestAll(child, x, y, results);
  }
  
  // Then check self
  if (node.containsPoint(x, y)) {
    results.push({
      id: node.id,
      depth: node.depth,
      structuralIndex: node.structuralIndex,
      interactive: node.interactive,
    });
  }
  
  return results;
}

/**
 * Hit test with structural priority
 * Higher structural index = later in traversal = higher priority
 */
export function hitTestWithPriority(node, x, y) {
  const hits = hitTestAll(node, x, y);
  
  // Filter to interactive only
  const interactive = hits.filter(h => h.interactive);
  
  if (interactive.length === 0) return null;
  
  // Return highest structural index (drawn last = on top)
  interactive.sort((a, b) => b.structuralIndex - a.structuralIndex);
  
  // Find actual node
  return findNodeById(node, interactive[0].id);
}

/**
 * Find node by ID in tree
 */
function findNodeById(node, id) {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNodeById(child, id);
    if (found) return found;
  }
  return null;
}

/**
 * Check if point is within any node
 */
export function pointInTree(node, x, y) {
  return hitTest(node, x, y) !== null;
}

export default {
  hitTest,
  hitTestAll,
  hitTestWithPriority,
  pointInTree,
};
