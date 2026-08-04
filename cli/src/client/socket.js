'use strict';

const { io } = require('socket.io-client');
const { cookieHeader } = require('../store/session');

class SocketClient {
  constructor({ server, session, onEvent } = {}) {
    this.server = String(server || '').replace(/\/+$/, '');
    this.session = session;
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.socket = null;
    this.joinedRooms = new Set();
  }

  connect() {
    if (this.socket?.connected) return this.socket;
    if (!this.server) throw new Error('Server URL is required for socket connection');
    const cookie = cookieHeader(this.session);
    this.socket = io(this.server, {
      // Prefer polling first so Node cookie headers apply reliably; upgrade optional.
      transports: ['polling', 'websocket'],
      withCredentials: true,
      autoConnect: true,
      reconnection: true,
      extraHeaders: cookie ? { Cookie: cookie } : {},
      transportOptions: cookie
        ? {
          polling: { extraHeaders: { Cookie: cookie } },
          websocket: { extraHeaders: { Cookie: cookie } },
        }
        : undefined,
    });

    const forward = (event) => {
      this.socket.on(event, (payload) => this.onEvent(event, payload));
    };

    [
      'connect',
      'disconnect',
      'connect_error',
      'error',
      'new_message',
      'message_edited',
      'message_deleted',
      'messages_cleared',
      'member_joined',
      'member_left',
      'member_kicked',
      'group_disbanded',
      'group_renamed',
      'group_settings_updated',
      'user_updated',
      'typing',
      'stop_typing',
      'presence_update',
      'channel_announce',
      'group_join_denied',
      'attachment_upload_progress',
      'attachment_upload_failed',
    ].forEach(forward);

    return this.socket;
  }

  async waitConnected(timeoutMs = 10000) {
    this.connect();
    if (this.socket.connected) return this.socket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
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
      const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeoutMs);
      this.socket.emit(event, payload, (response) => {
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
};
