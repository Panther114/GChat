'use strict';

const crypto = require('crypto');

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

function normalizeJoinCode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(normalized)) return null;
  return normalized;
}

function hashJoinCode(value, pepper) {
  const normalized = normalizeJoinCode(value);
  if (!normalized || typeof pepper !== 'string' || pepper.length < 32) return null;
  return crypto.createHmac('sha256', pepper).update(normalized, 'utf8').digest('hex');
}

function isValidKeyCommitment(value) {
  return typeof value === 'string' && BASE64URL_32_BYTES.test(value);
}

function safeEqualString(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  hashJoinCode,
  isValidKeyCommitment,
  normalizeJoinCode,
  safeEqualString,
};
