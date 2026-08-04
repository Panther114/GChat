'use strict';

/**
 * Encryption v2 port for the GChat CLI (Node).
 * Mirrors web client contract: AES-256-GCM + HKDF-SHA-256.
 * Intentionally local to cli/ so web/desktop sources stay untouched.
 */

const { webcrypto } = require('node:crypto');
const { TextDecoder, TextEncoder } = require('node:util');

const crypto = webcrypto;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ENCRYPTION_VERSION = 2;
const KEY_VERSION = 1;

function bytesToBase64Url(bytes) {
  const buf = Buffer.from(bytes);
  return buf.toString('base64url');
}

function base64UrlToBytes(value) {
  return new Uint8Array(Buffer.from(String(value), 'base64url'));
}

function generateGroupSecret() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function generateInviteCode() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  while (code.length < 6) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    for (const byte of bytes) {
      if (byte >= 252) continue;
      code += alphabet[byte % alphabet.length];
      if (code.length === 6) break;
    }
  }
  return code;
}

async function keyCommitment(secret) {
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

function messageAad({ groupId, id, senderId, type = 'text', keyVersion = KEY_VERSION, revision = 1 }) {
  return encoder.encode(JSON.stringify({ groupId, id, senderId, type, keyVersion, revision }));
}

async function encryptJson(value, secret, groupId, purpose, aad) {
  const key = await deriveKey(secret, groupId, purpose, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    encoder.encode(JSON.stringify(value))
  );
  return { encryptedContent: bytesToBase64Url(new Uint8Array(ciphertext)), iv: bytesToBase64Url(iv) };
}

async function decryptJson(ciphertext, iv, secret, groupId, purpose, aad) {
  const key = await deriveKey(secret, groupId, purpose, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToBytes(iv), additionalData: aad },
    key,
    base64UrlToBytes(ciphertext)
  );
  return JSON.parse(decoder.decode(plaintext));
}

async function encryptBytes(buffer, secret, groupId, aad) {
  const key = await deriveKey(secret, groupId, 'content', ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, data);
  return { encryptedBytes: new Uint8Array(ciphertext), iv: bytesToBase64Url(iv) };
}

async function decryptBytes(ciphertext, iv, secret, groupId, aad) {
  const key = await deriveKey(secret, groupId, 'content', ['decrypt']);
  const data = ciphertext instanceof Uint8Array ? ciphertext : base64UrlToBytes(ciphertext);
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToBytes(iv), additionalData: aad },
    key,
    data
  );
}

async function blindIndex(value, secret, groupId, purpose = 'tag-index') {
  if (!value) return null;
  const key = await deriveKey(secret, groupId, purpose, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(String(value).trim().toLocaleLowerCase()));
  return bytesToBase64Url(new Uint8Array(signature));
}

function randomUuid() {
  return crypto.randomUUID();
}

module.exports = {
  ENCRYPTION_VERSION,
  KEY_VERSION,
  bytesToBase64Url,
  base64UrlToBytes,
  generateGroupSecret,
  generateInviteCode,
  keyCommitment,
  messageAad,
  encryptJson,
  decryptJson,
  encryptBytes,
  decryptBytes,
  blindIndex,
  randomUuid,
};
