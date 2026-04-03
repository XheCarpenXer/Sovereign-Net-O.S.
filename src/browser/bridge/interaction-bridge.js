/**
 * INTERACTION BRIDGE - DIK to Transaction Kernel bridge
 * Converts UI intents into signed, replayable transactions
 * 
 * DIK NEVER mutates state - it only emits intents.
 * The bridge converts intents to kernel transactions.
 */

/**
 * InteractionBridge - bridges DIK intents to kernel transactions
 */
export class InteractionBridge {
  constructor(kernel, options = {}) {
    this.kernel = kernel; // State kernel reference
    this.intentLog = []; // Log of all intents for replay
    this.onTransaction = options.onTransaction || null;
  }
  
  /**
   * Handle intent from DIK
   * Converts to transaction and executes
   */
  handle(intent) {
    // Log intent
    this.intentLog.push(intent);
    
    // Create transaction payload
    const transaction = {
      type: 'ui.intent',
      payload: {
        type: intent.type,
        target: intent.target,
        ...intent.payload,
      },
      timestamp: intent.tick,
    };
    
    // Execute through kernel if available
    if (this.kernel && this.kernel.executeTransaction) {
      return this.kernel.executeTransaction(transaction);
    }
    
    // Callback if provided
    if (this.onTransaction) {
      this.onTransaction(transaction);
    }
    
    return transaction;
  }
  
  /**
   * Get all logged intents
   */
  getIntentLog() {
    return [...this.intentLog];
  }
  
  /**
   * Clear intent log
   */
  clearLog() {
    this.intentLog = [];
  }
  
  /**
   * Replay intents through kernel
   */
  replay(intents) {
    const results = [];
    for (const intent of intents) {
      results.push(this.handle(intent));
    }
    return results;
  }
}

/**
 * Create a bridge that connects DIK to mesh network
 * Intents become signed events that propagate to peers
 */
export function createNetworkBridge(dikInstance, wsConnection, identity) {
  const bridge = new InteractionBridge(null, {
    onTransaction: (tx) => {
      // Create signed event from transaction
      const event = {
        type: 'event',
        event: {
          cid: generateCID(tx),
          payload: tx,
          author: identity.did,
          ts: Date.now(),
          sig: null, // Would be signed in real implementation
        },
      };
      
      // Send over WebSocket
      if (wsConnection && wsConnection.readyState === 1) {
        wsConnection.send(JSON.stringify(event));
      }
    },
  });
  
  // Wire up DIK intent handler
  dikInstance.setIntentHandler((intent) => bridge.handle(intent));
  
  return bridge;
}

/**
 * Simple CID generation (hash of content)
 */
function generateCID(obj) {
  const str = JSON.stringify(obj);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `cid_${Math.abs(hash).toString(16)}`;
}

export default {
  InteractionBridge,
  createNetworkBridge,
};
