'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const { CLI_NAME, CLI_VERSION } = require('../version');
const { parseCommand, helpText, commandHelp, COMMAND_AREAS } = require('./parser');
const { GChatClient } = require('../client/api');
const { loadConfig, setConfigKey, saveConfig } = require('../store/config');
const { configPaths } = require('../store/paths');
const { formatMessageLine, parseDurationToMs } = require('../client/messages');
const { listVaultEntries } = require('../store/vault');
const { loadPrefs, savePrefs } = require('../store/prefs');
const cryptoV2 = require('../crypto-v2');
const { encryptTextEnvelope, decryptServerMessage } = require('../client/messages');

function createContext(options = {}) {
  const paths = options.paths || configPaths(options.configDir);
  const config = loadConfig(paths);
  const server = options.server || config.server;
  const client = options.client || new GChatClient({ server, paths, onEvent: options.onEvent });
  return {
    paths,
    config,
    client,
    json: !!options.json,
    yes: !!options.yes,
    out: options.out || ((text) => process.stdout.write(`${text}\n`)),
    err: options.err || ((text) => process.stderr.write(`${text}\n`)),
  };
}

function print(ctx, data) {
  if (ctx.json) {
    ctx.out(JSON.stringify(data, null, 2));
  } else if (typeof data === 'string') {
    ctx.out(data);
  } else {
    ctx.out(JSON.stringify(data, null, 2));
  }
}

async function promptHidden(question) {
  if (!input.isTTY) {
    throw new Error('Password prompt requires an interactive TTY');
  }
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input, output, terminal: true });
    const onData = (char) => {
      const c = char.toString();
      if (c === '\n' || c === '\r' || c === '\u0004') {
        input.removeListener('data', onData);
      } else {
        // mute
      }
    };
    output.write(question);
    input.on('data', onData);
    rl.question('', (answer) => {
      input.removeListener('data', onData);
      rl.close();
      output.write('\n');
      resolve(answer);
    });
    rl.on('error', reject);
  });
}

async function promptLine(question) {
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function confirm(ctx, message) {
  if (ctx.yes) return true;
  if (!input.isTTY) return false;
  const answer = await promptLine(`${message} [y/N] `);
  return /^y(es)?$/i.test(String(answer || '').trim());
}

async function resolveActiveGroup(ctx, flagGroup) {
  return ctx.client.resolveGroup(flagGroup || null);
}

async function handleCommand(parsed, ctx) {
  const { name, args, flags } = parsed;
  if (flags.server) {
    ctx.client.http.setServer(flags.server);
  }
  ctx.json = ctx.json || !!flags.json;
  ctx.yes = ctx.yes || !!flags.yes || flags.yes === true;

  switch (name) {
    case 'help':
      return print(ctx, args[0] ? commandHelp(args[0]) : helpText());

    case 'version': {
      let serverVersion = null;
      try {
        const { body } = await ctx.client.http.get('/api/meta/version');
        serverVersion = body;
      } catch {
        serverVersion = null;
      }
      if (ctx.json) {
        return print(ctx, { client: CLI_NAME, version: CLI_VERSION, server: serverVersion });
      }
      const serverPart = serverVersion
        ? ` server=${serverVersion.version || serverVersion.name || JSON.stringify(serverVersion)}`
        : ' server=(unreachable)';
      return print(ctx, `${CLI_NAME} ${CLI_VERSION}${serverPart}`);
    }

    case 'doctor': {
      const result = await ctx.client.doctor();
      if (ctx.json) return print(ctx, result);
      const lines = [
        `server: ${result.server}`,
        `health: ${result.health ? JSON.stringify(result.health) : 'fail'}`,
        `version: ${result.version ? JSON.stringify(result.version) : 'fail'}`,
        `session: ${result.me ? `${result.me.username} (${result.me.id})` : 'not logged in'}`,
        `crypto: ${result.crypto}`,
      ];
      if (result.errors.length) lines.push(`notes: ${result.errors.join('; ')}`);
      return print(ctx, lines.join('\n'));
    }

    case 'status': {
      const prefs = loadPrefs(ctx.paths);
      const user = ctx.client.user;
      const data = {
        server: ctx.client.server,
        user: user ? { id: user.id, username: user.username } : null,
        activeGroupId: prefs.activeGroupId,
        socket: ctx.client.socket?.connected || false,
      };
      if (prefs.activeGroupId) {
        data.channel = require('../store/prefs').getActiveChannel(prefs.activeGroupId, ctx.paths);
      }
      return print(ctx, ctx.json ? data : [
        `server: ${data.server}`,
        `user: ${data.user ? data.user.username : '(none)'}`,
        `group: ${data.activeGroupId || '(none)'}`,
        `channel: ${data.channel || 'main'}`,
        `socket: ${data.socket ? 'connected' : 'disconnected'}`,
      ].join('\n'));
    }

    case 'config':
    case 'config get': {
      const cfg = loadConfig(ctx.paths);
      if (args[0]) return print(ctx, { [args[0]]: cfg[args[0]] });
      return print(ctx, cfg);
    }

    case 'config set': {
      if (args.length < 2) throw new Error('Usage: gchat config set <key> <value>');
      const next = setConfigKey(args[0], args.slice(1).join(' '), ctx.paths);
      if (args[0] === 'server') ctx.client.http.setServer(next.server);
      return print(ctx, next);
    }

    case 'config path':
      return print(ctx, ctx.paths.root);

    case 'login': {
      const username = flags.u || flags.user || args[0] || await promptLine('Username: ');
      const password = flags.p || flags.password || args[1] || await promptHidden('Password: ');
      const user = await ctx.client.login(username.trim(), password, {
        rememberMe: flags.remember !== false && flags.remember !== 'false',
      });
      return print(ctx, ctx.json ? user : `Logged in as ${user.username}`);
    }

    case 'register': {
      const username = flags.u || flags.user || args[0] || await promptLine('Username: ');
      const password = flags.p || flags.password || args[1] || await promptHidden('Password: ');
      const user = await ctx.client.register(username.trim(), password, {
        iconColor: flags.color || flags.c,
      });
      return print(ctx, ctx.json ? user : `Registered and logged in as ${user.username}`);
    }

    case 'logout': {
      await ctx.client.logout();
      return print(ctx, 'Logged out');
    }

    case 'whoami': {
      const user = await ctx.client.me();
      return print(ctx, ctx.json ? user : `${user.username} (${user.id})`);
    }

    case 'account':
    case 'account show': {
      const user = await ctx.client.me();
      return print(ctx, user);
    }

    case 'account rename': {
      if (!args[0]) throw new Error('Usage: gchat account rename <name>');
      const user = await ctx.client.updateProfile({ username: args[0] });
      return print(ctx, ctx.json ? user : `Username set to ${user.username}`);
    }

    case 'account color': {
      if (!args[0]) throw new Error('Usage: gchat account color <#hex>');
      const user = await ctx.client.updateProfile({ iconColor: args[0] });
      return print(ctx, ctx.json ? user : `Color set to ${user.iconColor || args[0]}`);
    }

    case 'account avatar': {
      const target = args[0];
      if (!target) throw new Error('Usage: gchat account avatar <path|clear>');
      if (target === 'clear') {
        const user = await ctx.client.updateProfile({ profilePicture: null });
        return print(ctx, ctx.json ? user : 'Avatar cleared');
      }
      const buf = fs.readFileSync(path.resolve(target));
      const ext = path.extname(target).toLowerCase().replace('.', '') || 'png';
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      const user = await ctx.client.updateProfile({ profilePicture: dataUrl });
      return print(ctx, ctx.json ? user : 'Avatar updated');
    }

    case 'account delete': {
      if (!(await confirm(ctx, 'Delete account permanently?'))) throw new Error('Aborted');
      await ctx.client.deleteAccount();
      return print(ctx, 'Account deleted');
    }

    case 'settings':
    case 'settings get': {
      const s = await ctx.client.getSettings();
      return print(ctx, s);
    }

    case 'settings set': {
      if (args.length < 2) throw new Error('Usage: gchat settings set <key> <value>');
      const key = args[0];
      let value = args.slice(1).join(' ');
      if (value === 'true') value = true;
      if (value === 'false') value = false;
      if (/^\d+$/.test(String(value))) value = Number(value);
      const s = await ctx.client.setSettings({ [key]: value });
      return print(ctx, s);
    }

    case 'groups':
    case 'groups list': {
      const groups = await ctx.client.listGroups();
      if (ctx.json) return print(ctx, groups);
      if (!groups.length) return print(ctx, '(no groups)');
      return print(ctx, groups.map((g) => {
        const unread = g.unreadCount ? ` [${g.unreadCount} unread]` : '';
        return `${g.name}  ${g.id}${unread}`;
      }).join('\n'));
    }

    case 'groups open':
    case 'open': {
      const target = args[0] || flags.group;
      const { group, messages, channel } = await ctx.client.openGroup(target);
      const decrypted = await ctx.client.decryptMessages(group.id, messages);
      if (ctx.json) return print(ctx, { group, channel, messages: decrypted });
      const lines = [
        `Opened ${group.name} (#${channel})`,
        ...decrypted
          .filter((d) => !channel || d.channel === channel || d.channel === 'main')
          .slice(-30)
          .map((d) => formatMessageLine(d.msg, d)),
      ];
      return print(ctx, lines.join('\n'));
    }

    case 'groups create': {
      const name = args.join(' ') || flags.name;
      if (!name) throw new Error('Usage: gchat groups create <name> [--code c]');
      const result = await ctx.client.createGroup(name, flags.code || null);
      return print(ctx, ctx.json ? result : `Created ${result.group.name} invite=${result.joinCode}`);
    }

    case 'groups join':
    case 'join': {
      const code = args[0] || flags.code;
      if (!code) throw new Error('Usage: gchat groups join <code>');
      const group = await ctx.client.joinGroup(code);
      return print(ctx, ctx.json ? group : `Joined ${group.name} (${group.id})`);
    }

    case 'groups keys sync':
    case 'vault sync': {
      const keys = await ctx.client.syncKeys();
      return print(ctx, ctx.json ? keys : `Synced ${keys.length} group key(s)`);
    }

    case 'groups invite': {
      const group = await resolveActiveGroup(ctx, args[0] || flags.group);
      let code = ctx.client.inviteCode(group.id);
      if (!code) {
        await ctx.client.syncKeys();
        code = ctx.client.inviteCode(group.id);
      }
      if (!code) throw new Error('Invite code not in local vault. Try vault sync after joining.');
      return print(ctx, ctx.json ? { groupId: group.id, joinCode: code } : code);
    }

    case 'groups rename': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const name = args.join(' ');
      if (!name) throw new Error('Usage: gchat groups rename <name>');
      await ctx.client.renameGroup(group.id, name);
      return print(ctx, `Renamed to ${name}`);
    }

    case 'groups leave': {
      const group = await resolveActiveGroup(ctx, args[0] || flags.group);
      if (!(await confirm(ctx, `Leave ${group.name}?`))) throw new Error('Aborted');
      await ctx.client.leaveGroup(group.id);
      return print(ctx, `Left ${group.name}`);
    }

    case 'groups disband': {
      const group = await resolveActiveGroup(ctx, args[0] || flags.group);
      if (!(await confirm(ctx, `Disband ${group.name}? This cannot be undone.`))) throw new Error('Aborted');
      await ctx.client.disbandGroup(group.id);
      return print(ctx, `Disbanded ${group.name}`);
    }

    case 'groups clear': {
      const group = await resolveActiveGroup(ctx, flags.group);
      if (!(await confirm(ctx, `Clear messages in ${group.name}?`))) throw new Error('Aborted');
      await ctx.client.clearMessages(group.id, flags.channel || args[0]);
      return print(ctx, 'Messages cleared');
    }

    case 'groups settings': {
      const group = await resolveActiveGroup(ctx, args[0] || flags.group);
      return print(ctx, group);
    }

    case 'groups settings set': {
      const group = await resolveActiveGroup(ctx, flags.group);
      if (args.length < 2) throw new Error('Usage: gchat groups settings set <key> <value>');
      const key = args[0];
      let value = args.slice(1).join(' ');
      if (value === 'true') value = true;
      if (value === 'false') value = false;
      if (value === 'null' || value === 'clear') value = null;
      await ctx.client.updateGroupSettings(group.id, { [key]: value });
      return print(ctx, `Updated ${key}`);
    }

    case 'groups color': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const color = args[0] === 'clear' ? null : args[0];
      await ctx.client.updateGroupSettings(group.id, { groupColor: color });
      return print(ctx, `Group color set`);
    }

    case 'groups icon': {
      const group = await resolveActiveGroup(ctx, flags.group);
      if (args[0] === 'clear') {
        await ctx.client.updateGroupSettings(group.id, { groupIcon: null });
        return print(ctx, 'Group icon cleared');
      }
      if (!args[0]) throw new Error('Usage: gchat groups icon <path|clear>');
      const buf = fs.readFileSync(path.resolve(args[0]));
      const ext = path.extname(args[0]).toLowerCase().replace('.', '') || 'png';
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      await ctx.client.updateGroupSettings(group.id, { groupIcon: dataUrl });
      return print(ctx, 'Group icon updated');
    }

    case 'groups preload': {
      const data = await ctx.client.preload(flags.limit || args[0] || 50);
      return print(ctx, ctx.json ? data : `Preloaded ${Array.isArray(data) ? data.length : 0} group(s)`);
    }

    case 'members':
    case 'members list': {
      const group = await resolveActiveGroup(ctx, args[0] || flags.group);
      const members = await ctx.client.listMembers(group.id);
      if (ctx.json) return print(ctx, members);
      return print(ctx, members.map((m) => {
        const role = m.isAdministrator ? ' admin' : '';
        return `${m.username}  ${m.id}${role}`;
      }).join('\n'));
    }

    case 'members kick': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const who = args[0];
      if (!who) throw new Error('Usage: gchat members kick <user>');
      const members = await ctx.client.listMembers(group.id);
      const target = members.find((m) => m.id === who || m.username.toLowerCase() === who.toLowerCase());
      if (!target) throw new Error(`Member not found: ${who}`);
      if (!(await confirm(ctx, `Kick ${target.username}?`))) throw new Error('Aborted');
      await ctx.client.kickMember(group.id, target.id);
      return print(ctx, `Kicked ${target.username}`);
    }

    case 'members admin grant':
    case 'members admin revoke': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const who = args[0];
      if (!who) throw new Error('Usage: gchat members admin grant|revoke <user>');
      const members = await ctx.client.listMembers(group.id);
      const target = members.find((m) => m.id === who || m.username.toLowerCase() === who.toLowerCase());
      if (!target) throw new Error(`Member not found: ${who}`);
      const grant = name.endsWith('grant');
      await ctx.client.setAdministrator(group.id, target.id, grant);
      return print(ctx, `${grant ? 'Granted' : 'Revoked'} admin for ${target.username}`);
    }

    case 'presence': {
      return print(ctx, 'Presence is updated live in the TUI via socket events. Use `members` for roster.');
    }

    case 'channel':
    case 'channel list': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const channels = ctx.client.getChannels(group.id);
      const active = require('../store/prefs').getActiveChannel(group.id, ctx.paths);
      if (ctx.json) return print(ctx, { active, channels });
      return print(ctx, channels.map((c) => `${c === active ? '*' : ' '} #${c}`).join('\n'));
    }

    case 'channel switch':
    case 'channel main': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const ch = name === 'channel main' ? 'main' : (args[0] || 'main');
      const active = ctx.client.switchChannel(group.id, ch);
      return print(ctx, `Channel #${active}`);
    }

    case 'channel create': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const ch = args[0];
      if (!ch) throw new Error('Usage: gchat channel create <name>');
      await ctx.client.connectSocket();
      ctx.client.announceChannel(group.id, ch, 'create');
      ctx.client.switchChannel(group.id, ch);
      return print(ctx, `Created and switched to #${require('../store/prefs').normalizeChannel(ch)}`);
    }

    case 'channel delete': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const ch = args[0];
      if (!ch) throw new Error('Usage: gchat channel delete <name>');
      if (!(await confirm(ctx, `Delete channel #${ch}?`))) throw new Error('Aborted');
      await ctx.client.connectSocket();
      ctx.client.announceChannel(group.id, ch, 'delete');
      ctx.client.switchChannel(group.id, 'main');
      return print(ctx, `Deleted #${ch}, now on #main`);
    }

    case 'send': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const text = args.join(' ') || flags.text;
      if (!text) throw new Error('Usage: gchat send <text>');
      const result = await ctx.client.sendText({
        groupId: group.id,
        text,
        channel: flags.channel,
      });
      return print(ctx, ctx.json ? result : `Sent ${result.messageId}`);
    }

    case 'reply': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const replyToId = args[0];
      const text = args.slice(1).join(' ');
      if (!replyToId || !text) throw new Error('Usage: gchat reply <msgId> <text>');
      const result = await ctx.client.sendText({ groupId: group.id, text, replyToId, channel: flags.channel });
      return print(ctx, ctx.json ? result : `Replied ${result.messageId}`);
    }

    case 'edit': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const messageId = args[0];
      const text = args.slice(1).join(' ');
      if (!messageId || !text) throw new Error('Usage: gchat edit <msgId> <text>');
      const body = await ctx.client.editMessage(group.id, messageId, text);
      return print(ctx, ctx.json ? body : `Edited ${messageId}`);
    }

    case 'delete': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const messageId = args[0];
      if (!messageId) throw new Error('Usage: gchat delete <msgId>');
      if (!(await confirm(ctx, `Delete message ${messageId}?`))) throw new Error('Aborted');
      await ctx.client.deleteMessage(group.id, messageId);
      return print(ctx, `Deleted ${messageId}`);
    }

    case 'history': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const messages = await ctx.client.fetchMessages(group.id, {
        limit: flags.limit || 50,
        before: flags.before || null,
      });
      const decrypted = await ctx.client.decryptMessages(group.id, messages);
      const channel = flags.channel || require('../store/prefs').getActiveChannel(group.id, ctx.paths);
      const filtered = decrypted.filter((d) => !channel || d.channel === channel);
      if (ctx.json) return print(ctx, filtered);
      return print(ctx, filtered.map((d) => formatMessageLine(d.msg, d)).join('\n') || '(no messages)');
    }

    case 'read': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const messageId = args[0];
      if (!messageId) throw new Error('Usage: gchat read <msgId>');
      await ctx.client.connectSocket();
      ctx.client.markRead(group.id, messageId);
      return print(ctx, `Marked read ${messageId}`);
    }

    case 'typing': {
      const group = await resolveActiveGroup(ctx, flags.group);
      await ctx.client.connectSocket();
      ctx.client.emitTyping(group.id, !!flags.stop);
      return print(ctx, flags.stop ? 'stop_typing' : 'typing');
    }

    case 'whisper': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const who = args[0];
      const text = args.slice(1).join(' ');
      if (!who || !text) throw new Error('Usage: gchat whisper <user[,user2]> <text>');
      const members = await ctx.client.listMembers(group.id);
      const names = who.split(',').map((s) => s.trim()).filter(Boolean);
      const ids = names.map((n) => {
        const m = members.find((x) => x.id === n || x.username.toLowerCase() === n.toLowerCase());
        if (!m) throw new Error(`Member not found: ${n}`);
        return m.id;
      });
      const result = await ctx.client.sendText({
        groupId: group.id,
        text,
        whisperTo: ids,
        channel: flags.channel,
      });
      return print(ctx, ctx.json ? result : `Whisper sent ${result.messageId}`);
    }

    case 'disappear': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const duration = args[0];
      const text = args.slice(1).join(' ');
      if (!duration || !text) throw new Error('Usage: gchat disappear <duration> <text>  (server allows ~3s–22.5s)');
      const ms = parseDurationToMs(duration);
      if (!ms) throw new Error('Invalid duration (server allows 3000–22500 ms)');
      const result = await ctx.client.sendText({
        groupId: group.id,
        text,
        isDisappearing: true,
        disappearingDurationMs: ms,
        channel: flags.channel,
      });
      return print(ctx, ctx.json ? result : `Disappearing message ${result.messageId} (${ms}ms)`);
    }

    case 'hide': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const messageId = args[0];
      if (!messageId) throw new Error('Usage: gchat hide <msgId>');
      await ctx.client.connectSocket();
      ctx.client.hideDisappearing(group.id, messageId);
      return print(ctx, `Hide requested for ${messageId}`);
    }

    case 'timer start':
    case 'timer': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const messageId = args[0] || args[1];
      if (!messageId) throw new Error('Usage: gchat timer start <msgId>');
      await ctx.client.connectSocket();
      ctx.client.startDisappearingTimer(group.id, messageId);
      return print(ctx, `Timer started for ${messageId}`);
    }

    case 'upload':
    case 'upload-image': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const filePath = args[0];
      if (!filePath) throw new Error('Usage: gchat upload <path>');
      const result = await ctx.client.uploadFile(group.id, filePath, {
        type: name === 'upload-image' || flags.as === 'image' ? 'image' : flags.as,
      });
      return print(ctx, ctx.json ? result : `Uploaded ${result.filename} as ${result.messageId}`);
    }

    case 'file':
    case 'file list': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const messages = await ctx.client.fetchMessages(group.id, { limit: 100 });
      const files = messages.filter((m) => m.type === 'file' || m.type === 'image');
      if (ctx.json) return print(ctx, files);
      return print(ctx, files.map((m) => `${m.id}  ${m.type}  ${m.senderName || m.senderId}  ${m.createdAt || ''}`).join('\n') || '(no files)');
    }

    case 'file save': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const messageId = args[0];
      const outPath = args[1];
      if (!messageId || !outPath) throw new Error('Usage: gchat file save <msgId> <path>');
      const result = await ctx.client.saveAttachment(group.id, messageId, outPath);
      return print(ctx, ctx.json ? result : `Saved ${result.bytes} bytes to ${result.path}`);
    }

    case 'file open': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const messageId = args[0];
      if (!messageId) throw new Error('Usage: gchat file open <msgId>');
      const tmp = path.join(require('node:os').tmpdir(), `gchat-${messageId}`);
      const result = await ctx.client.saveAttachment(group.id, messageId, tmp);
      return print(ctx, `Saved to ${result.path} (open with your OS file manager)`);
    }

    case 'search': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const query = args.join(' ');
      if (!query) throw new Error('Usage: gchat search <query>');
      const hits = await ctx.client.searchMessages(group.id, query, { limit: flags.limit || 100 });
      if (ctx.json) return print(ctx, hits);
      return print(ctx, hits.map((d) => formatMessageLine(d.msg, d)).join('\n') || '(no matches)');
    }

    case 'export': {
      const group = await resolveActiveGroup(ctx, args[0] || flags.group);
      const result = await ctx.client.exportChat(group.id, { outPath: flags.o || flags.out || args[1] });
      if (result.path) return print(ctx, `Exported ${result.lines} lines to ${result.path}`);
      return print(ctx, result.content);
    }

    case 'copy invite': {
      const group = await resolveActiveGroup(ctx, flags.group);
      let code = ctx.client.inviteCode(group.id);
      if (!code) {
        await ctx.client.syncKeys();
        code = ctx.client.inviteCode(group.id);
      }
      if (!code) throw new Error('No invite code in vault');
      return print(ctx, code);
    }

    case 'copy message': {
      const group = await resolveActiveGroup(ctx, flags.group);
      const messageId = args[0];
      if (!messageId) throw new Error('Usage: gchat copy message <msgId>');
      const messages = await ctx.client.fetchMessages(group.id, { limit: 100 });
      const msg = messages.find((m) => String(m.id) === String(messageId));
      if (!msg) throw new Error('Message not found');
      const [dec] = await ctx.client.decryptMessages(group.id, [msg]);
      return print(ctx, dec.text || '');
    }

    case 'connect': {
      await ctx.client.connectSocket();
      return print(ctx, 'Socket connected');
    }

    case 'disconnect': {
      ctx.client.disconnectSocket();
      return print(ctx, 'Socket disconnected');
    }

    case 'mute': {
      const prefs = loadPrefs(ctx.paths);
      if (!args[0] || args[0] === 'all') {
        prefs.muteAll = true;
      } else {
        const group = await resolveActiveGroup(ctx, args[0]);
        prefs.mutedGroups = prefs.mutedGroups || {};
        prefs.mutedGroups[group.id] = true;
      }
      savePrefs(prefs, ctx.paths);
      return print(ctx, 'Muted');
    }

    case 'unmute': {
      const prefs = loadPrefs(ctx.paths);
      if (!args[0] || args[0] === 'all') {
        prefs.muteAll = false;
        prefs.mutedGroups = {};
      } else {
        const group = await resolveActiveGroup(ctx, args[0]);
        if (prefs.mutedGroups) delete prefs.mutedGroups[group.id];
      }
      savePrefs(prefs, ctx.paths);
      return print(ctx, 'Unmuted');
    }

    case 'notify': {
      const on = (args[0] || 'on') !== 'off';
      setConfigKey('notify', on, ctx.paths);
      setConfigKey('bell', on, ctx.paths);
      return print(ctx, `Notify ${on ? 'on' : 'off'}`);
    }

    case 'vault':
    case 'vault list': {
      const entries = listVaultEntries(ctx.paths);
      if (ctx.json) return print(ctx, entries.map((e) => ({ groupId: e.groupId, joinCode: e.joinCode, hasSecret: !!e.secret })));
      return print(ctx, entries.map((e) => `${e.groupId}  code=${e.joinCode || '?'}  secret=***`).join('\n') || '(empty vault)');
    }

    case 'vault export': {
      if (!(await confirm(ctx, 'Export vault secrets to stdout/file? DANGEROUS'))) throw new Error('Aborted');
      const data = ctx.client.vaultExport();
      if (flags.o || flags.out) {
        fs.writeFileSync(path.resolve(flags.o || flags.out), JSON.stringify(data, null, 2));
        return print(ctx, `Wrote vault to ${flags.o || flags.out}`);
      }
      return print(ctx, data);
    }

    case 'vault import': {
      const file = args[0];
      if (!file) throw new Error('Usage: gchat vault import <file>');
      const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
      const entries = data.entries || data;
      ctx.client.vaultImport(entries);
      return print(ctx, `Imported ${Object.keys(entries).length} entries`);
    }

    case 'vault forget': {
      const group = await resolveActiveGroup(ctx, args[0] || flags.group);
      ctx.client.vaultForget(group.id);
      return print(ctx, `Forgot key for ${group.id}`);
    }

    case 'crypto selftest':
    case 'crypto': {
      const secret = cryptoV2.generateGroupSecret();
      const groupId = cryptoV2.randomUuid();
      const senderId = cryptoV2.randomUuid();
      const { envelope } = await encryptTextEnvelope({
        text: 'selftest-ok',
        secret,
        groupId,
        senderId,
      });
      const dec = await decryptServerMessage(envelope, secret, groupId);
      if (dec.text !== 'selftest-ok') throw new Error('Crypto selftest failed');
      return print(ctx, ctx.json
        ? { ok: true, encryptionVersion: envelope.encryptionVersion, hasTagIndex: !!envelope.tagIndex }
        : 'crypto selftest ok');
    }

    case 'admin users': {
      const users = await ctx.client.adminUsers();
      return print(ctx, users);
    }

    case 'admin user delete': {
      throw new Error('admin user delete is not enabled in CLI without explicit server support wiring');
    }

    case 'ai':
    case 'ai chat':
      throw new Error('AI is unavailable in Increment A');

    case 'quit':
      return print(ctx, 'Use Ctrl+C or :q inside the TUI to quit.');

    case 'tui':
      return { __tui: true };

    case 'focus':
    case 'next-unread':
    case 'jump-unread':
    case 'bottom':
    case 'top':
    case 'older':
    case 'select':
    case 'theme':
    case 'bell':
    case 'redraw':
      return print(ctx, `TUI navigation command ":${name}" — run gchat (interactive) to use it.`);

    default:
      throw new Error(`Unknown command: ${name}\nRun: gchat help`);
  }
}

async function runParsed(parsed, options = {}) {
  const ctx = createContext(options);
  return handleCommand(parsed, ctx);
}

async function runArgv(argv, options = {}) {
  const parsed = parseCommand(argv);
  // Default to TUI when no args
  if ((!argv || argv.length === 0) && !options.forceCommand) {
    return { __tui: true, ctx: createContext(options) };
  }
  // `gchat help` etc.
  if (parsed.name === 'tui') {
    return { __tui: true, ctx: createContext(options) };
  }
  return handleCommand(parsed, createContext({
    ...options,
    json: options.json || !!parsed.flags.json,
    yes: options.yes || !!parsed.flags.yes,
    server: options.server || parsed.flags.server,
  }));
}

module.exports = {
  createContext,
  handleCommand,
  runParsed,
  runArgv,
  COMMAND_AREAS,
  parseCommand,
  helpText,
};
