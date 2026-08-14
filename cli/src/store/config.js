'use strict';

const { DEFAULT_SERVER } = require('../version');
const { configPaths, readJson, writeJson } = require('./paths');

const DEFAULT_CONFIG = {
  server: DEFAULT_SERVER,
  theme: 'dark',
  bell: true,
  notify: false,
  adminSecret: null,
  scrollSensitivity: 1,
};

const SCROLL_SENSITIVITY_MIN = 1;
const SCROLL_SENSITIVITY_MAX = 20;

function normalizeScrollSensitivity(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return SCROLL_SENSITIVITY_MIN;
  return Math.max(SCROLL_SENSITIVITY_MIN, Math.min(SCROLL_SENSITIVITY_MAX, n));
}

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
  if (key === 'scrollSensitivity') {
    parsed = normalizeScrollSensitivity(value);
  }
  current[key] = parsed;
  return saveConfig(current, paths);
}

module.exports = {
  DEFAULT_CONFIG,
  SCROLL_SENSITIVITY_MIN,
  SCROLL_SENSITIVITY_MAX,
  normalizeScrollSensitivity,
  loadConfig,
  saveConfig,
  setConfigKey,
};
