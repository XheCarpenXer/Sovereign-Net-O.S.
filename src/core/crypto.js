/**
 * CRYPTO - ECDSA P-256, AES-GCM-256, SHA-256, PBKDF2
 * All cryptographic primitives for SOVEREIGN OS
 */

import crypto from 'crypto';

// --- SHA-256 ---
export function sha256(data) {
  const input = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(input).digest('hex');
}

// --- ECDSA P-256 Key Generation ---
export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  
  // Export as hex for wire transmission
  const pubHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
  const privHex = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex');
  
  return { publicKey, privateKey, pubHex, privHex };
}

// --- Import keys from hex ---
export function importPublicKey(pubHex) {
  const der = Buffer.from(pubHex, 'hex');
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export function importPrivateKey(privHex) {
  const der = Buffer.from(privHex, 'hex');
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

// --- ECDSA Sign ---
export function sign(data, privateKey) {
  const input = typeof data === 'string' ? data : JSON.stringify(data);
  const signer = crypto.createSign('SHA256');
  signer.update(input);
  signer.end();
  return signer.sign(privateKey, 'hex');
}

// --- ECDSA Verify ---
export function verify(data, signature, publicKey) {
  try {
    const input = typeof data === 'string' ? data : JSON.stringify(data);
    const verifier = crypto.createVerify('SHA256');
    verifier.update(input);
    verifier.end();
    return verifier.verify(publicKey, signature, 'hex');
  } catch {
    return false;
  }
}

// --- AES-GCM-256 Encrypt ---
export function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const keyBuffer = typeof key === 'string' ? Buffer.from(key, 'hex') : key;
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  
  return {
    iv: iv.toString('hex'),
    encrypted,
    authTag,
  };
}

// --- AES-GCM-256 Decrypt ---
export function decrypt(cipherObj, key) {
  const keyBuffer = typeof key === 'string' ? Buffer.from(key, 'hex') : key;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keyBuffer,
    Buffer.from(cipherObj.iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(cipherObj.authTag, 'hex'));
  
  let decrypted = decipher.update(cipherObj.encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// --- PBKDF2 Key Derivation ---
export function deriveKey(password, salt, iterations = 100000) {
  const saltBuffer = typeof salt === 'string' ? Buffer.from(salt, 'hex') : salt;
  return crypto.pbkdf2Sync(password, saltBuffer, iterations, 32, 'sha256').toString('hex');
}

// --- Generate random bytes ---
export function randomBytes(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

// --- Generate DID from public key ---
export function generateDID(pubHex) {
  const hash = sha256(pubHex);
  return `did:sos:${hash.slice(0, 32)}`;
}

export default {
  sha256,
  generateKeyPair,
  importPublicKey,
  importPrivateKey,
  sign,
  verify,
  encrypt,
  decrypt,
  deriveKey,
  randomBytes,
  generateDID,
};
