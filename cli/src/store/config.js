'use strict';

const { DEFAULT_SERVER } = require('../version');
const { configPaths, readJson, writeJson } = require('./paths');

const DEFAULT_CONFIG = {
  server: DEFAULT_SERVER,
  theme: 'dark',
  bell: true,
  notify: false,
  adminSecret: null,
};

function loadConfig(paths) {
  const p = paths || configPaths();
  const stored = readJson(p.config, {});
  return { ...DEFAULT_CONFIG, ...stored };
}

function saveConfig(config, paths) {
  const p = paths || configPaths();
  const next = { ...DEFAULT_CONFIG, ...config };
  writeJson(p.config, next);
  return next;
}

function setConfigKey(key, value, paths) {
  const current = loadConfig(paths);
  if (!(key in DEFAULT_CONFIG) && key !== 'server') {
    const allowed = Object.keys(DEFAULT_CONFIG).join(', ');
    throw new Error(`Unknown config key "${key}". Allowed: ${allowed}`);
  }
  let parsed = value;
  if (key === 'bell' || key === 'notify') {
    parsed = value === true || value === 'true' || value === '1' || value === 'on';
  }
  if (key === 'adminSecret' && (value === 'null' || value === 'clear' || value === '')) {
    parsed = null;
  }
  if (key === 'theme') {
    parsed = String(value || '').trim().toLowerCase() === 'light' ? 'light' : 'dark';
  }
  current[key] = parsed;
  return saveConfig(current, paths);
}

module.exports = {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  setConfigKey,
};
