/**
 * STORAGE - Filesystem persistence + shard store
 * All data persisted to ~/.sovereign-os/
 */

import fs from 'fs';
import path from 'path';
import CONFIG from './config.js';

const { dataDir } = CONFIG;

// Ensure data directory exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Initialize storage
export function initStorage() {
  ensureDir(dataDir);
  ensureDir(path.join(dataDir, 'shards'));
  return true;
}

// --- JSON File Operations ---

export function readJSON(filename) {
  const filepath = path.join(dataDir, filename);
  try {
    if (fs.existsSync(filepath)) {
      const data = fs.readFileSync(filepath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error(`[storage] Error reading ${filename}:`, err.message);
  }
  return null;
}

export function writeJSON(filename, data) {
  ensureDir(dataDir);
  const filepath = path.join(dataDir, filename);
  try {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`[storage] Error writing ${filename}:`, err.message);
    return false;
  }
}

export function appendJSON(filename, item) {
  const existing = readJSON(filename) || [];
  existing.push(item);
  return writeJSON(filename, existing);
}

// --- Identity ---

export function loadIdentity() {
  return readJSON('identity.json');
}

export function saveIdentity(identity) {
  return writeJSON('identity.json', identity);
}

// --- Event Log ---

export function loadEventLog() {
  return readJSON('event-log.json') || [];
}

export function saveEventLog(events) {
  return writeJSON('event-log.json', events);
}

export function appendEvent(event) {
  return appendJSON('event-log.json', event);
}

// --- State Snapshot ---

export function loadState() {
  return readJSON('state.json') || {};
}

export function saveState(state) {
  return writeJSON('state.json', state);
}

// --- Ledger Blocks ---

export function loadLedgerBlocks() {
  return readJSON('ledger-blocks.json') || [];
}

export function saveLedgerBlocks(blocks) {
  return writeJSON('ledger-blocks.json', blocks);
}

// --- Known Peers ---

export function loadKnownPeers() {
  return readJSON('known-peers.json') || [];
}

export function saveKnownPeers(peers) {
  return writeJSON('known-peers.json', peers);
}

// --- Shard Store ---

export function loadShardIndex() {
  return readJSON('shard-index.json') || {};
}

export function saveShardIndex(index) {
  return writeJSON('shard-index.json', index);
}

export function writeShard(shardId, data) {
  const shardPath = path.join(dataDir, 'shards', `${shardId}.json`);
  try {
    fs.writeFileSync(shardPath, JSON.stringify(data), 'utf8');
    return true;
  } catch (err) {
    console.error(`[storage] Error writing shard ${shardId}:`, err.message);
    return false;
  }
}

export function readShard(shardId) {
  const shardPath = path.join(dataDir, 'shards', `${shardId}.json`);
  try {
    if (fs.existsSync(shardPath)) {
      const data = fs.readFileSync(shardPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error(`[storage] Error reading shard ${shardId}:`, err.message);
  }
  return null;
}

export function deleteShard(shardId) {
  const shardPath = path.join(dataDir, 'shards', `${shardId}.json`);
  try {
    if (fs.existsSync(shardPath)) {
      fs.unlinkSync(shardPath);
      return true;
    }
  } catch (err) {
    console.error(`[storage] Error deleting shard ${shardId}:`, err.message);
  }
  return false;
}

export default {
  initStorage,
  readJSON,
  writeJSON,
  appendJSON,
  loadIdentity,
  saveIdentity,
  loadEventLog,
  saveEventLog,
  appendEvent,
  loadState,
  saveState,
  loadLedgerBlocks,
  saveLedgerBlocks,
  loadKnownPeers,
  saveKnownPeers,
  loadShardIndex,
  saveShardIndex,
  writeShard,
  readShard,
  deleteShard,
};
