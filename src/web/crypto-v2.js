const encoder = new TextEncoder();
const decoder = new TextDecoder();
const VAULT_DB = 'gchat-key-vault-v2';
const VAULT_STORE = 'group-keys';

export const ENCRYPTION_VERSION = 2;
export const KEY_VERSION = 1;

export function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function generateGroupSecret() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function generateInviteCode() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  while (code.length < 6) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    for (const byte of bytes) {
      // Rejection sampling keeps every character equally likely.
      if (byte >= 252) continue;
      code += alphabet[byte % alphabet.length];
      if (code.length === 6) break;
    }
  }
  return code;
}

export async function keyCommitment(secret) {
  const digest = await crypto.subtle.digest('SHA-256', base64UrlToBytes(secret));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function deriveKey(secret, groupId, purpose, usage) {
  const material = await crypto.subtle.importKey('raw', base64UrlToBytes(secret), 'HKDF', false, ['deriveKey']);
  const algorithm = {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: encoder.encode(groupId),
    info: encoder.encode(`gchat-${purpose}-v2`),
  };
  if (purpose === 'content' || purpose === 'metadata') {
    return crypto.subtle.deriveKey(algorithm, material, { name: 'AES-GCM', length: 256 }, false, usage);
  }
  return crypto.subtle.deriveKey(algorithm, material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, usage);
}

export function messageAad({ groupId, id, senderId, type = 'text', keyVersion = KEY_VERSION, revision = 1 }) {
  return encoder.encode(JSON.stringify({ groupId, id, senderId, type, keyVersion, revision }));
}

export async function encryptJson(value, secret, groupId, purpose, aad) {
  const key = await deriveKey(secret, groupId, purpose, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, encoder.encode(JSON.stringify(value)));
  return { encryptedContent: bytesToBase64Url(new Uint8Array(ciphertext)), iv: bytesToBase64Url(iv) };
}

export async function decryptJson(ciphertext, iv, secret, groupId, purpose, aad) {
  const key = await deriveKey(secret, groupId, purpose, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64UrlToBytes(iv), additionalData: aad }, key, base64UrlToBytes(ciphertext));
  return JSON.parse(decoder.decode(plaintext));
}

export async function encryptBytes(buffer, secret, groupId, aad) {
  const key = await deriveKey(secret, groupId, 'content', ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, buffer);
  return { encryptedBytes: new Uint8Array(ciphertext), iv: bytesToBase64Url(iv) };
}

export async function decryptBytes(ciphertext, iv, secret, groupId, aad) {
  const key = await deriveKey(secret, groupId, 'content', ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64UrlToBytes(iv), additionalData: aad }, key, ciphertext);
}

export async function blindIndex(value, secret, groupId, purpose = 'tag-index') {
  if (!value) return null;
  const key = await deriveKey(secret, groupId, purpose, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(String(value).trim().toLocaleLowerCase()));
  return bytesToBase64Url(new Uint8Array(signature));
}

function openVault() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VAULT_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(VAULT_STORE, { keyPath: 'groupId' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function vaultOperation(mode, operation) {
  const db = await openVault();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(VAULT_STORE, mode);
    const request = operation(transaction.objectStore(VAULT_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export const keyVault = {
  get: (groupId) => vaultOperation('readonly', (store) => store.get(groupId)),
  put: (entry) => vaultOperation('readwrite', (store) => store.put({ ...entry, encryptionVersion: ENCRYPTION_VERSION })),
  remove: (groupId) => vaultOperation('readwrite', (store) => store.delete(groupId)),
};

export async function localDebugSecret() {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode('gchat-increment-a-local-debug-secret'));
  return bytesToBase64Url(new Uint8Array(digest));
}
