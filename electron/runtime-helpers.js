'use strict';

const MAX_UNREAD_COUNT = 999;
const ERR_ABORTED = -3;

function normalizeUnreadCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(MAX_UNREAD_COUNT, Math.floor(numeric));
}

function badgeLabelForUnread(value) {
  const unread = normalizeUnreadCount(value);
  return unread > 99 ? '99+' : String(unread);
}

/**
 * Chromium reports an interrupted page load (user/parent navigation) as an
 * aborted load — it is not a connectivity failure and must never be recorded
 * as one nor re-arm the auto-retry monitor.
 */
function isAbortedLoadError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.code === ERR_ABORTED || error.errorCode === ERR_ABORTED) return true;
  return typeof error.message === 'string' && error.message.includes('ERR_ABORTED');
}

/**
 * Build the focus-group broadcast from a native-notification payload.
 * Backwards compatible: with no channel hint the original bare groupId is
 * returned; with one, the payload object carries both ids.
 */
function buildFocusGroupPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const { groupId, channelId } = payload;
  if (groupId == null || groupId === '') return null;
  if (channelId == null || channelId === '') return groupId;
  return { groupId, channelId };
}

/**
 * Resolve the first icon candidate that exists. Returns '' when none do (the
 * empty result is cached so the filesystem is not probed repeatedly) — the
 * tray still gets an app default instead of an invisible icon.
 */
function resolveIconPath(candidates, exists) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate) continue;
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // Unreadable candidates are treated as missing.
    }
  }
  return '';
}

module.exports = {
  ERR_ABORTED,
  MAX_UNREAD_COUNT,
  badgeLabelForUnread,
  buildFocusGroupPayload,
  isAbortedLoadError,
  normalizeUnreadCount,
  resolveIconPath,
};
