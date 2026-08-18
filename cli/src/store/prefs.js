'use strict';

const { configPaths, readJson, writeJson } = require('./paths');

const DEFAULT_PREFS = {
  activeGroupId: null,
  channels: {},
  channelLists: {},
  mutedGroups: {},
  hiddenChannels: {},
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

function hiddenSet(prefs, groupId) {
  const list = prefs.hiddenChannels?.[String(groupId)] || [];
  return new Set(list.map((item) => normalizeChannel(item)).filter(Boolean));
}

function pinMainFirst(names) {
  const rest = [];
  const seen = new Set(['main']);
  for (const name of names || []) {
    if (!name || name === 'main' || seen.has(name)) continue;
    seen.add(name);
    rest.push(name);
  }
  return ['main', ...rest];
}

function rememberChannel(groupId, channel, prefsIn, { force = false } = {}) {
  const prefs = prefsIn || loadPrefs();
  const key = String(groupId);
  const name = normalizeChannel(channel) || 'main';
  prefs.hiddenChannels = prefs.hiddenChannels || {};
  const hidden = hiddenSet(prefs, key);
  if (hidden.has(name) && !force) return prefs;
  if (force && hidden.has(name)) {
    hidden.delete(name);
    prefs.hiddenChannels[key] = Array.from(hidden);
  }
  const list = new Set(prefs.channelLists?.[key] || ['main']);
  list.add(name);
  prefs.channelLists = prefs.channelLists || {};
  prefs.channelLists[key] = pinMainFirst(Array.from(list));
  return prefs;
}

function forgetChannel(groupId, channel, paths) {
  const prefs = loadPrefs(paths);
  const name = normalizeChannel(channel);
  const key = String(groupId);
  if (!name || name === 'main') return listChannels(groupId, paths);
  prefs.hiddenChannels = prefs.hiddenChannels || {};
  const hidden = hiddenSet(prefs, key);
  hidden.add(name);
  prefs.hiddenChannels[key] = Array.from(hidden);
  const list = (prefs.channelLists?.[key] || []).filter((item) => normalizeChannel(item) !== name);
  prefs.channelLists = prefs.channelLists || {};
  prefs.channelLists[key] = pinMainFirst(list);
  savePrefs(prefs, paths);
  return listChannels(groupId, paths);
}

function listChannels(groupId, paths) {
  const prefs = loadPrefs(paths);
  const hidden = hiddenSet(prefs, groupId);
  const list = prefs.channelLists?.[String(groupId)] || ['main'];
  const unique = [];
  const seen = new Set();
  for (const item of list) {
    const name = normalizeChannel(item) || 'main';
    if (seen.has(name) || (name !== 'main' && hidden.has(name))) continue;
    seen.add(name);
    unique.push(name);
  }
  return pinMainFirst(unique);
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
  const pinned = pinMainFirst(unique);
  prefs.channelLists = prefs.channelLists || {};
  prefs.channelLists[String(groupId)] = pinned;
  savePrefs(prefs, paths);
  return pinned;
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
  forgetChannel,
  setChannelOrder,
  pinMainFirst,
  normalizeChannel,
};
