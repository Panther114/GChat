'use strict';

/**
 * Pure desktop update status helpers (no Electron I/O).
 * Used by the main-process updater controller and unit tests.
 */

const UPDATE_STATES = Object.freeze([
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'ready',
  'error',
]);

const INITIAL_UPDATE_STATUS = Object.freeze({
  state: 'idle',
  currentVersion: null,
  availableVersion: null,
  percent: null,
  message: null,
  error: null,
  checkedAt: null,
});

function parseSemverParts(version) {
  if (typeof version !== 'string') return null;
  const cleaned = version.trim().replace(/^v/i, '');
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** @returns {-1|0|1|null} null when either side is not a parseable semver */
function compareSemver(left, right) {
  const a = parseSemverParts(left);
  const b = parseSemverParts(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function isUpdateState(value) {
  return UPDATE_STATES.includes(value);
}

function createUpdateStatus(partial = {}) {
  return {
    ...INITIAL_UPDATE_STATUS,
    ...partial,
    state: isUpdateState(partial.state) ? partial.state : 'idle',
  };
}

/**
 * Reduce update UI state from discrete shell events.
 * @param {object} status
 * @param {object} event
 */
function reduceUpdateStatus(status, event) {
  const current = createUpdateStatus(status || {});
  const type = event && event.type;
  const checkedAt = event && event.checkedAt != null ? event.checkedAt : current.checkedAt;
  const currentVersion = event && event.currentVersion != null
    ? event.currentVersion
    : current.currentVersion;

  switch (type) {
    case 'reset':
      return createUpdateStatus({ currentVersion });
    case 'check-start':
      return createUpdateStatus({
        state: 'checking',
        currentVersion,
        availableVersion: null,
        percent: null,
        message: 'Checking for updates…',
        error: null,
        checkedAt: null,
      });
    case 'up-to-date':
      return createUpdateStatus({
        state: 'up-to-date',
        currentVersion,
        availableVersion: null,
        percent: null,
        message: (event && event.message) || 'You are up to date.',
        error: null,
        checkedAt: checkedAt || new Date().toISOString(),
      });
    case 'available':
      return createUpdateStatus({
        state: 'available',
        currentVersion,
        availableVersion: (event && event.availableVersion) || null,
        percent: 0,
        message: (event && event.message)
          || (event && event.availableVersion
            ? ('Update ' + event.availableVersion + ' is available.')
            : 'An update is available.'),
        error: null,
        checkedAt: checkedAt || new Date().toISOString(),
      });
    case 'download-progress': {
      const raw = Number(event && event.percent);
      const percent = Number.isFinite(raw)
        ? Math.max(0, Math.min(100, Math.floor(raw)))
        : current.percent;
      return createUpdateStatus({
        ...current,
        state: 'downloading',
        currentVersion,
        availableVersion: (event && event.availableVersion) != null
          ? event.availableVersion
          : current.availableVersion,
        percent,
        message: (event && event.message)
          || (percent != null ? ('Downloading… ' + percent + '%') : 'Downloading…'),
        error: null,
        checkedAt,
      });
    }
    case 'ready':
      return createUpdateStatus({
        state: 'ready',
        currentVersion,
        availableVersion: (event && event.availableVersion) != null
          ? event.availableVersion
          : current.availableVersion,
        percent: 100,
        message: (event && event.message) || 'Update ready to install.',
        error: null,
        checkedAt: checkedAt || new Date().toISOString(),
      });
    case 'error':
      return createUpdateStatus({
        state: 'error',
        currentVersion,
        availableVersion: current.availableVersion,
        percent: null,
        message: null,
        error: (event && (event.error || event.message)) || 'Update check failed.',
        checkedAt: checkedAt || new Date().toISOString(),
      });
    default:
      return current;
  }
}

function updateStatusLabel(status) {
  const normalized = createUpdateStatus(status);
  switch (normalized.state) {
    case 'checking':
      return 'Checking for updates…';
    case 'up-to-date':
      return normalized.message || 'You are up to date.';
    case 'available':
      return normalized.message || 'An update is available.';
    case 'downloading':
      return normalized.message || 'Downloading update…';
    case 'ready':
      return normalized.message || 'Update ready to install.';
    case 'error':
      return normalized.error || 'Update check failed.';
    case 'idle':
    default:
      return normalized.currentVersion
        ? ('Version ' + normalized.currentVersion)
        : 'Check for desktop updates when connected.';
  }
}

module.exports = {
  UPDATE_STATES,
  INITIAL_UPDATE_STATUS,
  parseSemverParts,
  compareSemver,
  isUpdateState,
  createUpdateStatus,
  reduceUpdateStatus,
  updateStatusLabel,
};
