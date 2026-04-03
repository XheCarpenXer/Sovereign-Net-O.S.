/**
 * DIK POINTER - Pointer lock management
 * 
 * Invariant: pointerId -> targetNode (locked until pointerup)
 * No re-resolution mid-frame
 */

export class PointerManager {
  constructor() {
    // Map of pointerId -> locked target node ID
    this.locks = new Map();
    
    // Map of pointerId -> pointer state
    this.pointers = new Map();
  }
  
  /**
   * Lock pointer to a target
   */
  lock(pointerId, targetId) {
    this.locks.set(pointerId, targetId);
    this.pointers.set(pointerId, {
      targetId,
      lockedAt: Date.now(),
    });
  }
  
  /**
   * Unlock pointer
   */
  unlock(pointerId) {
    this.locks.delete(pointerId);
    this.pointers.delete(pointerId);
  }
  
  /**
   * Get locked target for pointer
   */
  getLockedTarget(pointerId) {
    return this.locks.get(pointerId) || null;
  }
  
  /**
   * Check if pointer is locked
   */
  isLocked(pointerId) {
    return this.locks.has(pointerId);
  }
  
  /**
   * Get all active pointers
   */
  getActivePointers() {
    return Array.from(this.pointers.entries()).map(([id, state]) => ({
      pointerId: id,
      ...state,
    }));
  }
  
  /**
   * Clear all locks
   */
  clear() {
    this.locks.clear();
    this.pointers.clear();
  }
  
  /**
   * Get lock count
   */
  get count() {
    return this.locks.size;
  }
}

export default { PointerManager };
