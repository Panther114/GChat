'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  parseCommand,
  helpText,
  COMMAND_AREAS,
  isKnownArea,
} = require('../src/commands/parser');

test('help text lists major command groups', () => {
  const text = helpText();
  assert.match(text, /gchat/);
  for (const area of ['login', 'groups', 'channel', 'send', 'whisper', 'vault', 'doctor', 'history', 'members', 'upload']) {
    assert.match(text, new RegExp(area), `help should mention ${area}`);
  }
});

test('COMMAND_AREAS covers product surface', () => {
  const required = [
    'login', 'register', 'logout', 'account', 'groups', 'channel', 'send', 'reply',
    'edit', 'delete', 'history', 'whisper', 'disappear', 'members', 'upload', 'file',
    'search', 'export', 'vault', 'config', 'doctor', 'admin', 'tui',
  ];
  for (const area of required) {
    assert.ok(isKnownArea(area) || COMMAND_AREAS.includes(area), area);
  }
});

test('parseCommand handles nested groups create/join/open', () => {
  assert.equal(parseCommand(['groups', 'create', 'team']).name, 'groups create');
  assert.deepEqual(parseCommand(['groups', 'create', 'team']).args, ['team']);
  assert.equal(parseCommand(['groups', 'join', 'ab12cd']).name, 'groups join');
  assert.equal(parseCommand(['open', 'team']).name, 'open');
  assert.equal(parseCommand(['groups', 'keys', 'sync']).name, 'groups keys sync');
  assert.equal(parseCommand(['members', 'admin', 'grant', 'bob']).name, 'members admin grant');
});

test('parseCommand supports colon-style TUI lines', () => {
  const parsed = parseCommand(':send hello world');
  assert.equal(parsed.name, 'send');
  assert.deepEqual(parsed.args, ['hello', 'world']);
});

test('parseCommand extracts flags', () => {
  const parsed = parseCommand(['send', 'hi', '--group', 'eng', '--json']);
  assert.equal(parsed.name, 'send');
  assert.equal(parsed.flags.group, 'eng');
  assert.equal(parsed.flags.json, true);
});

test('quoted args stay together', () => {
  const parsed = parseCommand('send "hello there"');
  assert.equal(parsed.name, 'send');
  assert.deepEqual(parsed.args, ['hello there']);
});

test('full inventory areas parse without throwing', () => {
  const samples = [
    'login -u a -p b',
    'register',
    'logout',
    'whoami',
    'account show',
    'account rename bob',
    'settings get',
    'groups',
    'groups create room',
    'groups join code01',
    'groups leave',
    'groups disband',
    'groups clear',
    'groups rename New',
    'groups invite',
    'groups settings',
    'groups settings set allowMemberClear true',
    'channel list',
    'channel switch design',
    'channel create design',
    'channel delete design',
    'channel main',
    'send hello',
    'reply mid hi',
    'edit mid hi',
    'delete mid',
    'history --limit 20',
    'read mid',
    'whisper bob secret',
    'disappear 5s secret',
    'hide mid',
    'timer start mid',
    'members',
    'members kick bob',
    'members admin grant bob',
    'members admin revoke bob',
    'upload ./x.png',
    'file list',
    'file save mid out.bin',
    'search foo',
    'export -o out.txt',
    'copy invite',
    'copy message mid',
    'connect',
    'disconnect',
    'status',
    'doctor',
    'version',
    'config get server',
    'config set server http://localhost',
    'vault list',
    'vault sync',
    'vault export',
    'vault import f.json',
    'vault forget',
    'crypto selftest',
    'admin users',
    'mute all',
    'unmute all',
    'notify on',
    'tui',
    'help',
  ];
  for (const sample of samples) {
    const parsed = parseCommand(sample);
    assert.ok(parsed.name, sample);
    assert.ok(parsed.area, sample);
  }
});
