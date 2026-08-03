'use strict';

const MAX_UNREAD_COUNT = 999;

function normalizeUnreadCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(MAX_UNREAD_COUNT, Math.floor(numeric));
}

function badgeLabelForUnread(value) {
  const unread = normalizeUnreadCount(value);
  return unread > 99 ? '99+' : String(unread);
}

module.exports = {
  MAX_UNREAD_COUNT,
  badgeLabelForUnread,
  normalizeUnreadCount,
};
