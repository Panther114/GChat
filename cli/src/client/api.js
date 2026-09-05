'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cryptoV2 = require('../crypto-v2');
const { HttpClient } = require('./http');
const {
  encryptTextEnvelope,
  decryptServerMessage,
  decryptAttachmentMeta,
  encryptAttachmentEnvelope,
  decryptAttachment,
  parseDurationToMs,
  DEFAULT_CHANNEL,
} = require('./messages');
const { putVaultEntry, getVaultEntry, listVaultEntries, removeVaultEntry, loadVault, saveVault } = require('../store/vault');
const {
  getActiveChannel,
  setActiveChannel,
  listChannels,
  loadPrefs,
  savePrefs,
  normalizeChannel,
} = require('../store/prefs');
const { loadConfig } = require('../store/config');
const { clearSession } = require('../store/session');

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // server rejects attachments over 15MB
const IMAGE_MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

class GChatClient {
  constructor({ server, paths, onEvent } = {}) {
    this.paths = paths || null;
    this.http = new HttpClient({ server, paths: this.paths });
    this.socket = null;
    this.onEvent = onEvent;
    this._messageCache = new Map(); // groupId -> messages[]
  }

  get server() {
    return this.http.server;
  }

  get session() {
    return this.http.session;
  }

  get user() {
    return this.http.session.user;
  }

  async doctor() {
    const result = { server: this.server, health: null, version: null, me: null, crypto: null, errors: [] };
    try {
      const health = await this.http.get('/api/health');
      result.health = health.body;
    } catch (err) {
      result.errors.push(`health: ${err.message}`);
    }
    try {
      const version = await this.http.get('/api/meta/version');
      result.version = version.body;
    } catch (err) {
      result.errors.push(`version: ${err.message}`);
    }
    try {
      const me = await this.http.get('/api/auth/me');
      result.me = me.body;
      this.http.session.user = me.body;
      this.http.persistSession();
    } catch (err) {
      result.errors.push(`me: ${err.message}`);
    }
    try {
      const secret = cryptoV2.generateGroupSecret();
      const groupId = cryptoV2.randomUuid();
      const senderId = cryptoV2.randomUuid();
      const { envelope } = await encryptTextEnvelope({
        text: 'doctor-selftest',
        secret,
        groupId,
        senderId,
        channel: 'main',
      });
      const dec = await decryptServerMessage(envelope, secret, groupId);
      if (dec.text !== 'doctor-selftest') throw new Error('round-trip mismatch');
      result.crypto = 'ok';
    } catch (err) {
      result.crypto = `fail: ${err.message}`;
      result.errors.push(`crypto: ${err.message}`);
    }
    result.ok = result.errors.length === 0
      || !!(result.health && result.crypto === 'ok' && result.me && result.me.id);
    return result;
  }

  async login(username, password, { rememberMe = true } = {}) {
    const { body } = await this.http.post('/api/auth/login', {
      username,
      password,
      rememberMe: !!rememberMe,
    });
    this.http.session.user = body;
    this.http.persistSession();
    await this.http.ensureCsrf();
    await this.syncKeys().catch((err) => {
      process.stderr.write(`gchat: key sync failed: ${err?.message || err}\n`);
    });
    return body;
  }

  async register(username, password, { iconColor } = {}) {
    const payload = { username, password };
    if (iconColor) payload.iconColor = iconColor;
    const { body } = await this.http.post('/api/auth/register', payload);
    this.http.session.user = body;
    this.http.persistSession();
    await this.http.ensureCsrf();
    return body;
  }

  async logout() {
    try {
      await this.http.ensureCsrf().catch(() => {});
      await this.http.post('/api/auth/logout', {});
    } catch {
      /* still clear local */
    }
    this.disconnectSocket();
    clearSession(this.paths);
    this.http.session = clearSession(this.paths);
    return { ok: true };
  }

  async me() {
    const { body } = await this.http.get('/api/auth/me');
    this.http.session.user = body;
    this.http.persistSession();
    return body;
  }

  async updateProfile(patch) {
    await this.http.ensureCsrf();
    const { body } = await this.http.patch('/api/auth/profile', patch);
    this.http.session.user = body;
    this.http.persistSession();
    return body;
  }

  async deleteAccount() {
    await this.http.ensureCsrf();
    const { body } = await this.http.delete('/api/auth/account', {});
    clearSession(this.paths);
    this.http.session = clearSession(this.paths);
    return body;
  }

  async getSettings() {
    const { body } = await this.http.get('/api/auth/settings');
    return body;
  }

  async setSettings(patch) {
    await this.http.ensureCsrf();
    const { body } = await this.http.patch('/api/auth/settings', patch);
    return body;
  }

  async listGroups() {
    const { body } = await this.http.get('/api/groups/mine');
    return body;
  }

  async resolveGroup(nameOrId) {
    if (!nameOrId) {
      const prefs = loadPrefs(this.paths);
      if (prefs.activeGroupId) return this.getGroupById(prefs.activeGroupId);
      throw new Error('No active group. Use: gchat groups open <name>');
    }
    const groups = await this.listGroups();
    const q = String(nameOrId).toLowerCase();
    const byId = groups.find((g) => String(g.id) === String(nameOrId));
    if (byId) return byId;
    const exact = groups.find((g) => String(g.name).toLowerCase() === q);
    if (exact) return exact;
    const partial = groups.filter((g) => String(g.name).toLowerCase().includes(q));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) throw new Error(`Ambiguous group "${nameOrId}": ${partial.map((g) => g.name).join(', ')}`);
    throw new Error(`Group not found: ${nameOrId}`);
  }

  async getGroupById(id) {
    const groups = await this.listGroups();
    const g = groups.find((x) => String(x.id) === String(id));
    if (!g) throw new Error(`Group not found: ${id}`);
    return g;
  }

  setActiveGroup(groupId) {
    const prefs = loadPrefs(this.paths);
    prefs.activeGroupId = groupId;
    savePrefs(prefs, this.paths);
  }

  async createGroup(name, code) {
    await this.http.ensureCsrf();
    const secret = cryptoV2.generateGroupSecret();
    const invite = code || cryptoV2.generateInviteCode();
    const commitment = await cryptoV2.keyCommitment(secret);
    const { body } = await this.http.post('/api/groups/create', {
      name,
      code: invite,
      secret,
      keyCommitment: commitment,
    });
    putVaultEntry(body.id, { secret, joinCode: invite, encryptionVersion: 2 }, this.paths);
    this.setActiveGroup(body.id);
    return { group: body, joinCode: invite };
  }

  async joinGroup(code) {
    await this.http.ensureCsrf();
    const { body } = await this.http.post('/api/groups/join', { code });
    if (body.secret) {
      putVaultEntry(body.id, {
        secret: body.secret,
        joinCode: String(code).trim().toLowerCase(),
        encryptionVersion: 2,
      }, this.paths);
    }
    this.setActiveGroup(body.id);
    return body;
  }

  async syncKeys() {
    const { body } = await this.http.get('/api/groups/keys');
    const keys = Array.isArray(body.keys) ? body.keys : [];
    for (const entry of keys) {
      if (entry.groupId && entry.secret) {
        putVaultEntry(entry.groupId, {
          secret: entry.secret,
          joinCode: entry.joinCode || null,
          encryptionVersion: 2,
        }, this.paths);
      }
    }
    return keys;
  }

  getSecret(groupId) {
    const entry = getVaultEntry(groupId, this.paths);
    return entry?.secret || null;
  }

  async ensureSecret(groupId) {
    let secret = this.getSecret(groupId);
    if (secret) return secret;
    await this.syncKeys();
    secret = this.getSecret(groupId);
    if (!secret) throw new Error(`No encryption key for group ${groupId}. Try: gchat vault sync`);
    return secret;
  }

  async renameGroup(groupId, name) {
    await this.http.ensureCsrf();
    const { body } = await this.http.patch(`/api/groups/${groupId}/name`, { name });
    return body;
  }

  async leaveGroup(groupId) {
    await this.http.ensureCsrf();
    const { body } = await this.http.delete(`/api/groups/${groupId}/leave`, {});
    removeVaultEntry(groupId, this.paths);
    return body;
  }

  async disbandGroup(groupId) {
    await this.http.ensureCsrf();
    const { body } = await this.http.delete(`/api/groups/${groupId}`, {});
    removeVaultEntry(groupId, this.paths);
    return body;
  }

  async clearMessages(groupId, channel) {
    await this.http.ensureCsrf();
    if (channel && channel !== 'main') {
      const secret = await this.ensureSecret(groupId);
      const tagIndex = await cryptoV2.blindIndex(channel, secret, groupId, 'tag-index');
      const { body } = await this.http.delete(`/api/groups/${groupId}/tags/${encodeURIComponent(tagIndex)}/messages`, {});
      return body;
    }
    const { body } = await this.http.delete(`/api/groups/${groupId}/messages`, {});
    return body;
  }

  async updateGroupSettings(groupId, patch) {
    await this.http.ensureCsrf();
    const { body } = await this.http.patch(`/api/groups/${groupId}/settings`, patch);
    return body;
  }

  async listMembers(groupId) {
    const { body } = await this.http.get(`/api/groups/${groupId}/members`);
    return body;
  }

  async kickMember(groupId, userId) {
    await this.http.ensureCsrf();
    const { body } = await this.http.delete(`/api/groups/${groupId}/members/${userId}`, {});
    return body;
  }

  async setAdministrator(groupId, userId, isAdministrator) {
    await this.http.ensureCsrf();
    const { body } = await this.http.patch(
      `/api/groups/${groupId}/members/${userId}/administrator`,
      { isAdministrator: !!isAdministrator }
    );
    return body;
  }

  async fetchMessages(groupId, { limit = 50, before = null } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    let url = `/api/groups/${groupId}/messages?limit=${safeLimit}`;
    if (before) url += `&before=${encodeURIComponent(before)}`;
    const { body } = await this.http.get(url);
    const messages = Array.isArray(body) ? body : [];
    this._cacheMessages(groupId, messages);
    return messages;
  }

  _cacheMessages(groupId, messages) {
    const key = String(groupId);
    const existing = this._messageCache.get(key) || [];
    const byId = new Map(existing.map((m) => [m.id, m]));
    for (const m of messages) byId.set(m.id, m);
    const merged = Array.from(byId.values()).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    // Bound cache
    this._messageCache.set(key, merged.slice(-500));
  }

  getCachedMessages(groupId) {
    return this._messageCache.get(String(groupId)) || [];
  }

  async decryptMessages(groupId, messages) {
    const secret = await this.ensureSecret(groupId);
    const out = [];
    for (const msg of messages) {
      const dec = await decryptServerMessage(msg, secret, groupId);
      out.push({ msg, ...dec });
    }
    return out;
  }

  ensureSocket() {
    if (!this.socket) {
      const { SocketClient } = require('./socket');
      this.socket = new SocketClient({
        server: this.server,
        session: this.http.session,
        onEvent: (event, payload) => {
          if (event === 'sync_event' && payload?.message?.groupId) {
            this._cacheMessages(payload.message.groupId, [payload.message]);
          }
          if (this.onEvent) this.onEvent(event, payload);
        },
      });
    } else {
      this.socket.session = this.http.session;
    }
    return this.socket;
  }

  async connectSocket() {
    const sock = this.ensureSocket();
    await sock.waitConnected();
    return sock;
  }

  disconnectSocket() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  async openGroup(nameOrId) {
    const group = await this.resolveGroup(nameOrId);
    this.setActiveGroup(group.id);
    await this.ensureSecret(group.id);
    const sock = await this.connectSocket();
    sock.joinRoom(group.id);
    const messages = await this.fetchMessages(group.id, { limit: 50 });
    const channel = getActiveChannel(group.id, this.paths);
    return { group, messages, channel };
  }

  async sendText({
    groupId,
    text,
    channel,
    replyToId,
    replyPreview,
    whisperTo,
    isDisappearing,
    disappearingDurationMs,
  }) {
    const user = this.user || await this.me();
    const secret = await this.ensureSecret(groupId);
    const activeChannel = channel || getActiveChannel(groupId, this.paths) || DEFAULT_CHANNEL;
    const type = whisperTo?.length ? 'whisper' : 'text';
    const { envelope } = await encryptTextEnvelope({
      text,
      secret,
      groupId,
      senderId: user.id,
      type,
      channel: activeChannel,
      replyToId: replyToId || null,
      replyPreview: replyPreview || null,
      isDisappearing: !!isDisappearing,
      disappearingDurationMs: isDisappearing
        ? (parseDurationToMs(disappearingDurationMs) || parseDurationToMs('5s') || 5000)
        : null,
    });

    const sock = await this.connectSocket();
    sock.joinRoom(groupId);

    if (type === 'whisper') {
      sock.emit('send_whisper', { ...envelope, whisperTo });
      return { ok: true, messageId: envelope.id, envelope };
    }

    const ack = await sock.emitAck('send_message', envelope).catch(() => null);
    if (ack && ack.ok === false) {
      throw new Error(ack.error || 'send_message failed');
    }
    return { ok: true, messageId: envelope.id, envelope, ack };
  }

  async editMessage(groupId, messageId, newText) {
    const user = this.user || await this.me();
    const secret = await this.ensureSecret(groupId);
    const messages = this.getCachedMessages(groupId);
    let current = messages.find((m) => String(m.id) === String(messageId));
    if (!current) {
      const page = await this.fetchMessages(groupId, { limit: 100 });
      current = page.find((m) => String(m.id) === String(messageId));
    }
    if (!current) throw new Error(`Message not found in cache: ${messageId}`);
    // Edits must reuse the ORIGINAL message's channel/tag metadata, never the
    // caller's current active channel — otherwise the message migrates channels.
    const dec = await decryptServerMessage(current, secret, groupId);
    const channel = normalizeChannel(dec.channel) || DEFAULT_CHANNEL;
    const expectedRevision = Number(current.revision) || 1;
    const { envelope } = await encryptTextEnvelope({
      text: newText,
      secret,
      groupId,
      senderId: user.id,
      type: current.type || 'text',
      channel,
      messageId,
      revision: expectedRevision + 1,
      replyToId: current.replyToId || current.reply_to || null,
      replyPreview: dec.metadata?.replyPreview || null,
    });
    await this.http.ensureCsrf();
    const { body } = await this.http.patch(`/api/groups/${groupId}/messages/${messageId}`, {
      encryptedContent: envelope.encryptedContent,
      iv: envelope.iv,
      encryptedMetadata: envelope.encryptedMetadata,
      metadataIv: envelope.metadataIv,
      tagIndex: envelope.tagIndex,
      spamSignature: envelope.spamSignature,
      encryptionVersion: envelope.encryptionVersion,
      keyVersion: envelope.keyVersion,
      expectedRevision,
    });
    this._cacheMessages(groupId, [body]);
    return body;
  }

  async deleteMessage(groupId, messageId) {
    await this.http.ensureCsrf();
    const { body } = await this.http.delete(`/api/groups/${groupId}/messages/${messageId}`, {});
    return body;
  }

  markRead(groupId, messageId) {
    const sock = this.ensureSocket();
    sock.emit('mark_message_read', { groupId, messageId });
  }

  /**
   * Per-channel read cursor (server `mark_channel_read`): everything up to
   * (createdAt, messageId) in this channel counts as read. #main uses a null
   * tag index; other channels use the blind tag index of the channel name.
   */
  async markChannelRead(groupId, channel, { createdAt, messageId } = {}) {
    const secret = await this.ensureSecret(groupId);
    const normalized = normalizeChannel(channel) || DEFAULT_CHANNEL;
    const tagIndex = normalized === DEFAULT_CHANNEL
      ? null
      : await cryptoV2.blindIndex(normalized, secret, groupId, 'tag-index');
    const sock = this.ensureSocket();
    sock.emit('mark_channel_read', { groupId, tagIndex, createdAt, messageId });
    return true;
  }

  /**
   * Server-side channel discovery (GET /api/groups/:id/channels). Resolves
   * each blind tagIndex back to its plaintext topic via the sample message.
   * Bounded: a single GET per call.
   */
  async fetchChannels(groupId) {
    const { body } = await this.http.get(`/api/groups/${groupId}/channels`);
    const rows = Array.isArray(body?.channels) ? body.channels : [];
    const secret = this.getSecret(groupId);
    const out = [];
    for (const row of rows.slice(0, 200)) {
      const sample = row?.sampleMessage;
      if (!sample || !secret) continue;
      try {
        let name = null;
        if (sample.type === 'image' || sample.type === 'file') {
          const meta = await decryptAttachmentMeta(sample, secret, groupId);
          name = normalizeChannel(meta?.hashtag);
        } else {
          const dec = await decryptServerMessage(sample, secret, groupId);
          name = dec.error ? null : (normalizeChannel(dec.channel) || null);
        }
        if (name) out.push({ name, tagIndex: row.tagIndex, messageCount: Number(row.messageCount) || 0 });
      } catch {
        /* skip unresolvable channel */
      }
    }
    return out;
  }

  startDisappearingTimer(groupId, messageId) {
    const sock = this.ensureSocket();
    sock.emit('start_disappearing_timer', { groupId, messageId });
  }

  hideDisappearing(groupId, messageId) {
    const sock = this.ensureSocket();
    sock.emit('hide_disappearing_message', { groupId, messageId });
  }

  emitTyping(groupId, stop = false) {
    const sock = this.ensureSocket();
    sock.emit(stop ? 'stop_typing' : 'typing', { groupId });
  }

  announceChannel(groupId, channel, action = 'create') {
    const sock = this.ensureSocket();
    sock.joinRoom(groupId);
    const nextAction = action === 'delete' || action === 'remove' ? 'remove' : 'add';
    sock.emit('channel_announce', { groupId, channel, action: nextAction });
    if (nextAction === 'add') {
      setActiveChannel(groupId, channel, this.paths);
    }
  }

  switchChannel(groupId, channel) {
    const normalized = normalizeChannel(channel) || DEFAULT_CHANNEL;
    setActiveChannel(groupId, normalized, this.paths);
    return normalized;
  }

  getChannels(groupId) {
    return listChannels(groupId, this.paths);
  }

  async uploadFile(groupId, filePath, { type } = {}) {
    const user = this.user || await this.me();
    const secret = await this.ensureSecret(groupId);
    const abs = path.resolve(filePath);
    // Reject oversized files BEFORE reading them into memory.
    const stat = fs.statSync(abs);
    if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
    if (stat.size > MAX_UPLOAD_BYTES) {
      throw new Error(`Attachment too large (max 15MB): ${path.basename(abs)}`);
    }
    const buf = fs.readFileSync(abs);
    const filename = path.basename(abs);
    const ext = path.extname(filename).toLowerCase();
    const isImage = type === 'image' || Object.prototype.hasOwnProperty.call(IMAGE_MIME_BY_EXT, ext);
    const msgType = isImage ? 'image' : 'file';
    const channel = getActiveChannel(groupId, this.paths);
    const prepared = await encryptAttachmentEnvelope({
      buffer: buf,
      filename,
      mimeType: isImage ? (IMAGE_MIME_BY_EXT[ext] || 'image/png') : 'application/octet-stream',
      secret,
      groupId,
      senderId: user.id,
      type: msgType,
      channel,
    });

    await this.http.ensureCsrf();
    // Server accepts base64 JSON body as well as binary; use JSON path for simpler cookies/CSRF.
    const encryptedContent = Buffer.from(prepared.encryptedBytes).toString('base64');
    const { body } = await this.http.post(`/api/groups/${groupId}/upload`, {
      encryptedContent,
      iv: prepared.iv,
      type: msgType,
      messageId: prepared.identity.id,
      encryptedMetadata: prepared.encryptedMetadata,
      metadataIv: prepared.metadataIv,
      tagIndex: prepared.tagIndex,
      encryptionVersion: 2,
      keyVersion: 1,
      clientUploadId: prepared.identity.id,
    }, {
      headers: {
        'X-Encryption-Version': '2',
        'X-Key-Version': '1',
      },
    });
    return { messageId: body.messageId || prepared.identity.id, type: msgType, filename };
  }

  async saveAttachment(groupId, messageId, outPath) {
    const secret = await this.ensureSecret(groupId);
    let msg = this.getCachedMessages(groupId).find((m) => String(m.id) === String(messageId));
    if (!msg) {
      const page = await this.fetchMessages(groupId, { limit: 100 });
      msg = page.find((m) => String(m.id) === String(messageId));
    }
    if (!msg) throw new Error(`Message not found: ${messageId}`);
    if (!['file', 'image'].includes(msg.type)) throw new Error('Message is not an attachment');
    const { bytes, metadata } = await decryptAttachment(msg, secret, groupId);
    const target = path.resolve(outPath);
    fs.writeFileSync(target, bytes);
    return { path: target, filename: metadata.filename || path.basename(target), bytes: bytes.length };
  }

  async searchMessages(groupId, query, { limit = 100 } = {}) {
    const messages = await this.fetchMessages(groupId, { limit: Math.min(limit, 100) });
    const decrypted = await this.decryptMessages(groupId, messages);
    const q = String(query).toLowerCase();
    return decrypted.filter((d) => (d.text || '').toLowerCase().includes(q));
  }

  async exportChat(groupId, { outPath } = {}) {
    const messages = await this.fetchMessages(groupId, { limit: 100 });
    const decrypted = await this.decryptMessages(groupId, messages);
    const lines = [];
    for (const d of decrypted) {
      if (d.msg.isDisappearing) continue;
      const ts = d.msg.createdAt || '';
      const who = d.msg.senderName || d.msg.senderId;
      const text = d.text != null ? d.text : '[unable to decrypt]';
      lines.push(`[${ts}] ${who}: ${text}`);
    }
    const content = `${lines.join('\n')}\n`;
    if (outPath) {
      fs.writeFileSync(path.resolve(outPath), content, 'utf8');
      return { path: path.resolve(outPath), lines: lines.length, content };
    }
    return { content, lines: lines.length };
  }

  async preload(limit = 50) {
    const safe = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const { body } = await this.http.get(`/api/groups/preload?limit=${safe}`);
    return body;
  }

  async adminUsers() {
    const config = loadConfig(this.paths);
    if (!config.adminSecret) throw new Error('adminSecret not set in config');
    const { body } = await this.http.get('/api/admin/users', {
      headers: { Authorization: `Bearer ${config.adminSecret}` },
    });
    return body;
  }

  vaultList() {
    return listVaultEntries(this.paths);
  }

  vaultExport() {
    return loadVault(this.paths);
  }

  vaultImport(entries) {
    saveVault(entries, this.paths);
    return listVaultEntries(this.paths);
  }

  vaultForget(groupId) {
    return removeVaultEntry(groupId, this.paths);
  }

  inviteCode(groupId) {
    const entry = getVaultEntry(groupId, this.paths);
    return entry?.joinCode || null;
  }
}

module.exports = {
  GChatClient,
  IMAGE_MIME_BY_EXT,
  MAX_UPLOAD_BYTES,
};
