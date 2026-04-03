/**
 * CONFIG - System configuration
 * All ports, paths, and limits
 */

import { homedir } from 'os';
import { join } from 'path';

export const CONFIG = {
  // Protocol
  PROTOCOL_VERSION: 'sos/9.1',
  
  // Network - TCP
  tcpPort: 8567,
  
  // Network - WebSocket Hub
  wsPort: 8569,
  maxBrowserPeers: 100,
  
  // mDNS Discovery
  mdnsPort: 5353,
  mdnsMulticast: '224.0.0.251',
  serviceType: '_sos._tcp.local',
  
  // Timeouts
  pingInterval: 30000,
  peerTimeout: 90000,
  reconnectDelay: 5000,
  syncTimeout: 30000,
  
  // Storage
  dataDir: join(homedir(), '.sovereign-os'),
  
  // Bloom filter for gossip dedup
  bloomSize: 2048,
  bloomHashes: 3,
  
  // Event limits
  maxEventSize: 65536,
  maxBatchSize: 100,
};

export default CONFIG;
