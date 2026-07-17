'use strict';

const crypto = require('crypto');
const { normalizeJoinCode } = require('./group-security');

const ESCROW_VERSION = 1;
const MASTER_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const GROUP_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IV_BYTES = 12;

function parseEscrowMasterKey(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!MASTER_KEY_PATTERN.test(normalized)) {
    throw new Error('GROUP_KEY_ESCROW_MASTER_KEY must be a 32-byte base64url value');
  }
  const key = Buffer.from(normalized, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== normalized) {
    throw new Error('GROUP_KEY_ESCROW_MASTER_KEY must be a canonical 32-byte base64url value');
  }
  return key;
}

function isValidGroupSecret(value) {
  if (typeof value !== 'string' || !GROUP_SECRET_PATTERN.test(value)) return false;
  try {
    return Buffer.from(value, 'base64url').length === 32;
  } catch {
    return false;
  }
}

function normalizeEscrowPayload(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid group key escrow payload');
  const secret = typeof value.secret === 'string' ? value.secret : '';
  const joinCode = normalizeJoinCode(value.joinCode);
  if (!isValidGroupSecret(secret) || !joinCode) throw new Error('Invalid group key escrow payload');
  return { secret, joinCode };
}

function escrowAad(groupId) {
  return Buffer.from(`gchat:group-key-escrow:v${ESCROW_VERSION}:${String(groupId)}`, 'utf8');
}

function encryptEscrowPayload(masterKey, groupId, value) {
  const payload = normalizeEscrowPayload(value);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(escrowAad(groupId));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ v: ESCROW_VERSION, ...payload }), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    ciphertext: ciphertext.toString('base64url'),
    iv: iv.toString('base64url'),
    version: ESCROW_VERSION,
  };
}

function decryptEscrowPayload(masterKey, groupId, value) {
  if (!value || Number(value.version) !== ESCROW_VERSION || typeof value.ciphertext !== 'string' || typeof value.iv !== 'string') {
    throw new Error('Unsupported group key escrow payload');
  }
  const iv = Buffer.from(value.iv, 'base64url');
  const encrypted = Buffer.from(value.ciphertext, 'base64url');
  if (iv.length !== IV_BYTES || encrypted.length <= 16) throw new Error('Invalid group key escrow payload');
  const ciphertext = encrypted.subarray(0, -16);
  const authTag = encrypted.subarray(-16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAAD(escrowAad(groupId));
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  let decoded;
  try {
    decoded = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('Invalid group key escrow payload');
  }
  if (Number(decoded?.v) !== ESCROW_VERSION) throw new Error('Unsupported group key escrow payload');
  return normalizeEscrowPayload(decoded);
}

function keyCommitmentForSecret(secret) {
  if (!isValidGroupSecret(secret)) throw new Error('Invalid group encryption key');
  return crypto.createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('base64url');
}

module.exports = {
  ESCROW_VERSION,
  decryptEscrowPayload,
  encryptEscrowPayload,
  isValidGroupSecret,
  keyCommitmentForSecret,
  parseEscrowMasterKey,
};
