'use strict';

const { io } = require('socket.io-client');
const { cookieHeader } = require('../store/session');
const { SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION } = require('../version');

/**
 * Events the GChat server (v1.4.6) actually emits. Message lifecycle arrives
 * exclusively as `sync_event` (message.created / message.edited /
 * message.deleted / history.cleared) plus `sync_hint` — the legacy
 * new_message / message_edited / message_deleted emitters no longer exist.
 */
const SERVER_EVENTS = [
  'sync_event',
  'sync_hint',
  // Defensive: some deployments relay cleared notices under these names.
  'chat_cleared',
  'tag_cleared',
  'member_joined',
  'member_left',
  'member_kicked',
  'member_role_updated',
  'group_disbanded',
  'group_renamed',
  'group_settings_updated',
  'group_owner_transferred',
  'group_join_denied',
  'user_updated',
  'user_deleted',
  'account_deleted',
  'user_typing',
  'user_stop_typing',
  'presence_update',
  'channel_announced',
  'message_read_update',
  'read_cursor_updated',
  'attachment_upload_progress',
  'attachment_upload_failed',
];

function socketIoOptions(session) {
  const cookie = cookieHeader(session);
  const protocolHeaders = {
    [SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL_VERSION),
    ...(cookie ? { Cookie: cookie } : {}),
  };
  return {
    // Prefer polling first so Node cookie headers apply reliably; upgrade optional.
    transports: ['polling', 'websocket'],
    withCredentials: true,
    autoConnect: true,
    reconnection: true,
    // Bounded backoff so a flaky link never hammers the server with retries.
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
    randomizationFactor: 0.5,
    auth: { protocol: SYNC_PROTOCOL_VERSION },
    extraHeaders: protocolHeaders,
    transportOptions: {
      polling: { extraHeaders: protocolHeaders },
      websocket: { extraHeaders: protocolHeaders },
    },
  };
}

class SocketClient {
  constructor({ server, session, onEvent } = {}) {
    this.server = String(server || '').replace(/\/+$/, '');
    this.session = session;
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.socket = null;
    this.joinedRooms = new Set();
  }

  connect() {
    // socket.io auto-reconnects an existing socket; recreating it would lose
    // the tracked room list, so only build one when none exists.
    if (this.socket) return this.socket;
    if (!this.server) throw new Error('Server URL is required for socket connection');
    this.socket = io(this.server, socketIoOptions(this.session));

    // After every (re)connect, rejoin every tracked room so fan-out resumes.
    this.socket.on('connect', () => {
      this.rejoinRooms();
      this.onEvent('connect', null);
    });

    const forward = (event) => {
      this.socket.on(event, (payload) => this.onEvent(event, payload));
    };

    [
      'disconnect',
      'connect_error',
      'error',
      ...SERVER_EVENTS,
    ].forEach(forward);

    return this.socket;
  }

  async waitConnected(timeoutMs = 10000) {
    this.connect();
    if (this.socket.connected) return this.socket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        // A timed-out wait must not leak a reconnecting socket; drop it so a
        // one-shot command can exit and the process does not hang.
        this.disconnect();
        reject(new Error('Socket connection timed out'));
      }, timeoutMs);
      const onConnect = () => {
        cleanup();
        resolve(this.socket);
      };
      const onError = (err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err?.message || err)));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off('connect', onConnect);
        this.socket.off('connect_error', onError);
      };
      this.socket.on('connect', onConnect);
      this.socket.on('connect_error', onError);
    });
  }

  /** Re-emit join_room for every tracked room (used on initial and re-connects). */
  rejoinRooms() {
    if (!this.socket) return;
    for (const groupId of this.joinedRooms) {
      this.socket.emit('join_room', groupId);
    }
  }

  joinRoom(groupId) {
    if (!groupId) return;
    this.connect();
    this.socket.emit('join_room', groupId);
    this.joinedRooms.add(String(groupId));
  }

  emit(event, payload, ack) {
    this.connect();
    if (typeof ack === 'function') {
      this.socket.emit(event, payload, ack);
    } else {
      this.socket.emit(event, payload);
    }
  }

  emitAck(event, payload, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      this.connect();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${event} timed out`));
      }, timeoutMs);
      this.socket.emit(event, payload, (response) => {
        // A late ack after the timeout fired must settle silently, never throw.
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.joinedRooms.clear();
  }

  get connected() {
    return !!(this.socket && this.socket.connected);
  }
}

module.exports = {
  SocketClient,
  socketIoOptions,
};
