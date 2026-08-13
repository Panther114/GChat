'use strict';

const { configPaths, readJson, writeJson } = require('./paths');

const DEFAULT_PREFS = {
  activeGroupId: null,
  channels: {},
  channelLists: {},
  mutedGroups: {},
  muteAll: false,
};

function loadPrefs(paths) {
  const p = paths || configPaths();
  const stored = readJson(p.prefs, {});
  return { ...DEFAULT_PREFS, ...stored };
}

function savePrefs(prefs, paths) {
  const p = paths || configPaths();
  const next = { ...DEFAULT_PREFS, ...prefs };
  writeJson(p.prefs, next);
  return next;
}

function getActiveChannel(groupId, paths) {
  const prefs = loadPrefs(paths);
  const ch = prefs.channels?.[String(groupId)];
  return normalizeChannel(ch) || 'main';
}

function setActiveChannel(groupId, channel, paths) {
  const prefs = loadPrefs(paths);
  prefs.channels = prefs.channels || {};
  prefs.channels[String(groupId)] = normalizeChannel(channel) || 'main';
  rememberChannel(groupId, prefs.channels[String(groupId)], prefs);
  return savePrefs(prefs, paths);
}

function rememberChannel(groupId, channel, prefsIn) {
  const prefs = prefsIn || loadPrefs();
  const key = String(groupId);
  const list = new Set(prefs.channelLists?.[key] || ['main']);
  list.add(normalizeChannel(channel) || 'main');
  prefs.channelLists = prefs.channelLists || {};
  prefs.channelLists[key] = Array.from(list);
  return prefs;
}

function listChannels(groupId, paths) {
  const prefs = loadPrefs(paths);
  const list = prefs.channelLists?.[String(groupId)] || ['main'];
  const unique = [];
  const seen = new Set();
  for (const item of list) {
    const name = normalizeChannel(item) || 'main';
    if (seen.has(name)) continue;
    seen.add(name);
    unique.push(name);
  }
  if (!seen.has('main')) unique.unshift('main');
  return unique;
}

function setChannelOrder(groupId, ordered, paths) {
  const prefs = loadPrefs(paths);
  const unique = [];
  const seen = new Set();
  for (const item of ordered || []) {
    const name = normalizeChannel(item);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    unique.push(name);
  }
  if (!seen.has('main')) unique.unshift('main');
  prefs.channelLists = prefs.channelLists || {};
  prefs.channelLists[String(groupId)] = unique;
  savePrefs(prefs, paths);
  return unique;
}

function normalizeChannel(value) {
  if (value == null || value === '') return null;
  const trimmed = String(value).trim().replace(/^#/, '').toLowerCase();
  if (!trimmed || trimmed.length > 12) return null;
  return /^[a-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

module.exports = {
  DEFAULT_PREFS,
  loadPrefs,
  savePrefs,
  getActiveChannel,
  setActiveChannel,
  listChannels,
  rememberChannel,
  setChannelOrder,
  normalizeChannel,
};
