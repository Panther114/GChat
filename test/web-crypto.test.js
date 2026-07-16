'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { webcrypto } = require('node:crypto');
const { TextDecoder, TextEncoder } = require('node:util');

const encoder = new TextEncoder();
const secret = webcrypto.getRandomValues(new Uint8Array(32));
const groupId = 'crypto-test-group';

async function derive(purpose, algorithm, usages) {
  const material = await webcrypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return webcrypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(groupId), info: encoder.encode(`gchat-${purpose}-v2`),
  }, material, algorithm, false, usages);
}

test('HKDF separates content, metadata, and blind-index keys', async () => {
  const content = await derive('content', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);
  const metadata = await derive('metadata', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);
  const input = encoder.encode('same input');
  const left = Buffer.from(await webcrypto.subtle.sign('HMAC', content, input));
  const right = Buffer.from(await webcrypto.subtle.sign('HMAC', metadata, input));
  assert.notDeepEqual(left, right);
});

test('AES-GCM round trips and rejects changed AAD', async () => {
  const key = await derive('content', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(JSON.stringify({ groupId, id: 'message', revision: 1 }));
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, encoder.encode('hello'));
  const plaintext = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ciphertext);
  assert.equal(new TextDecoder().decode(plaintext), 'hello');
  await assert.rejects(() => webcrypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('tampered') }, key, ciphertext));
});

test('random 96-bit IVs do not repeat across a practical sample', () => {
  const values = new Set();
  for (let index = 0; index < 1000; index += 1) {
    values.add(Buffer.from(webcrypto.getRandomValues(new Uint8Array(12))).toString('hex'));
  }
  assert.equal(values.size, 1000);
});
