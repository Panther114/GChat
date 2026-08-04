'use strict';

const { configPaths, readJson, writeJson } = require('./paths');

function loadSession(paths) {
  const p = paths || configPaths();
  const data = readJson(p.session, null);
  if (!data || typeof data !== 'object') return { cookies: {}, csrfToken: null, user: null };
  return {
    cookies: data.cookies && typeof data.cookies === 'object' ? data.cookies : {},
    csrfToken: data.csrfToken || null,
    user: data.user || null,
  };
}

function saveSession(session, paths) {
  const p = paths || configPaths();
  const payload = {
    cookies: session.cookies || {},
    csrfToken: session.csrfToken || null,
    user: session.user || null,
  };
  writeJson(p.session, payload);
  return payload;
}

function clearSession(paths) {
  return saveSession({ cookies: {}, csrfToken: null, user: null }, paths);
}

function cookieHeader(session) {
  const cookies = session?.cookies || {};
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function storeSetCookieHeaders(session, setCookieList) {
  if (!Array.isArray(setCookieList)) return session;
  const next = { ...session, cookies: { ...(session.cookies || {}) } };
  for (const raw of setCookieList) {
    if (!raw || typeof raw !== 'string') continue;
    const part = raw.split(';')[0];
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    if (value === '' || /Max-Age=0/i.test(raw)) {
      delete next.cookies[name];
    } else {
      next.cookies[name] = value;
    }
  }
  return next;
}

module.exports = {
  loadSession,
  saveSession,
  clearSession,
  cookieHeader,
  storeSetCookieHeaders,
};
