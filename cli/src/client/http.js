'use strict';

const { loadConfig } = require('../store/config');
const {
  loadSession,
  saveSession,
  cookieHeader,
  storeSetCookieHeaders,
} = require('../store/session');
const { SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION } = require('../version');

class HttpClient {
  constructor({ server, paths, session } = {}) {
    this.paths = paths || null;
    this.config = loadConfig(this.paths);
    this.server = String(server || this.config.server || '').replace(/\/+$/, '');
    this.session = session || loadSession(this.paths);
  }

  setServer(url) {
    this.server = String(url || '').replace(/\/+$/, '');
  }

  persistSession() {
    if (this.paths !== undefined) {
      saveSession(this.session, this.paths);
    }
  }

  async request(method, apiPath, { body, headers, rawBody, binaryResponse } = {}) {
    if (!this.server) throw new Error('Server URL is not configured. Run: gchat config set server <url>');
    const url = `${this.server}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`;
    const reqHeaders = {
      Accept: 'application/json',
      [SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL_VERSION),
      ...(headers || {}),
    };
    const cookie = cookieHeader(this.session);
    if (cookie) reqHeaders.Cookie = cookie;
    if (this.session.csrfToken && !['GET', 'HEAD'].includes(method.toUpperCase())) {
      reqHeaders['X-CSRF-Token'] = this.session.csrfToken;
    }

    let payload = undefined;
    if (rawBody != null) {
      payload = rawBody;
      if (!reqHeaders['Content-Type'] && Buffer.isBuffer(rawBody)) {
        reqHeaders['Content-Type'] = 'application/octet-stream';
      }
    } else if (body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers: reqHeaders,
      body: payload,
      redirect: 'manual',
    });

    const setCookie = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : parseSetCookieFallback(response.headers.get('set-cookie'));
    if (setCookie && setCookie.length) {
      this.session = storeSetCookieHeaders(this.session, setCookie);
      this.persistSession();
    }

    if (binaryResponse) {
      const buf = Buffer.from(await response.arrayBuffer());
      if (!response.ok) {
        const err = new Error(`HTTP ${response.status}`);
        err.status = response.status;
        err.body = buf;
        throw err;
      }
      return { status: response.status, headers: response.headers, body: buf };
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!response.ok) {
      let message = data?.error || data?.message || `HTTP ${response.status}`;
      if (response.status === 426 || message === 'protocol_upgrade_required') {
        const need = data?.requiredProtocol || SYNC_PROTOCOL_VERSION;
        message = `protocol_upgrade_required (need ${need}; CLI speaks ${SYNC_PROTOCOL_VERSION})`;
      }
      const err = new Error(message);
      err.status = response.status;
      err.body = data;
      throw err;
    }
    return { status: response.status, headers: response.headers, body: data };
  }

  get(path, opts) {
    return this.request('GET', path, opts);
  }

  post(path, body, opts) {
    return this.request('POST', path, { ...opts, body });
  }

  patch(path, body, opts) {
    return this.request('PATCH', path, { ...opts, body });
  }

  delete(path, body, opts) {
    return this.request('DELETE', path, { ...opts, body });
  }

  async ensureCsrf() {
    const { body } = await this.get('/api/auth/csrf');
    this.session.csrfToken = body.csrfToken;
    this.persistSession();
    return body.csrfToken;
  }
}

function parseSetCookieFallback(header) {
  if (!header) return [];
  if (Array.isArray(header)) return header;
  // Node may join multiple set-cookie with comma — fragile but better than nothing.
  return String(header).split(/,(?=\s*[^;]+=[^;]+)/).map((s) => s.trim()).filter(Boolean);
}

module.exports = {
  HttpClient,
};
