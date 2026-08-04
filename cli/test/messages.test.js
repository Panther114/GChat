'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  parseDurationToMs,
  MIN_DISAPPEARING_MS,
  MAX_DISAPPEARING_MS,
  formatMessageLine,
} = require('../src/client/messages');

test('parseDurationToMs accepts server-allowed range', () => {
  assert.equal(parseDurationToMs('5s'), 5000);
  assert.equal(parseDurationToMs('3000'), 3000);
  assert.equal(parseDurationToMs('3s'), 3000);
  assert.equal(parseDurationToMs('22s'), 22000);
  assert.equal(parseDurationToMs('1s'), null); // below min
  assert.equal(parseDurationToMs('60s'), null); // above max
  assert.ok(MIN_DISAPPEARING_MS >= 3000);
  assert.ok(MAX_DISAPPEARING_MS <= 22500);
});

test('formatMessageLine includes sender and text', () => {
  const line = formatMessageLine(
    { senderName: 'alice', createdAt: '2026-01-01T00:00:00.000Z', type: 'text' },
    { text: 'hi', channel: 'main' }
  );
  assert.match(line, /alice/);
  assert.match(line, /hi/);
  assert.match(line, /#main/);
});
