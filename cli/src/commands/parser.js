'use strict';

/**
 * Parse shell argv or TUI colon/slash command lines into a structured command.
 */

const COMMAND_AREAS = [
  'help',
  'version',
  'doctor',
  'status',
  'config',
  'login',
  'logout',
  'register',
  'whoami',
  'account',
  'settings',
  'groups',
  'members',
  'presence',
  'channel',
  'send',
  'reply',
  'edit',
  'delete',
  'history',
  'read',
  'typing',
  'whisper',
  'disappear',
  'hide',
  'timer',
  'upload',
  'file',
  'search',
  'export',
  'copy',
  'connect',
  'disconnect',
  'mute',
  'unmute',
  'notify',
  'vault',
  'crypto',
  'admin',
  'ai',
  'tui',
  'quit',
  'open',
  'join',
  'focus',
  'next-unread',
  'jump-unread',
  'bottom',
  'top',
  'older',
  'select',
  'theme',
  'bell',
  'redraw',
];

function stripCommandPrefix(line) {
  const trimmed = String(line || '').trim();
  if (trimmed.startsWith(':') || trimmed.startsWith('/')) {
    return trimmed.slice(1).trim();
  }
  return trimmed;
}

function tokenize(input) {
  const tokens = [];
  const re = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g;
  let match;
  const str = String(input || '').trim();
  while ((match = re.exec(str)) !== null) {
    let tok = match[0];
    if ((tok.startsWith('"') && tok.endsWith('"')) || (tok.startsWith("'") && tok.endsWith("'"))) {
      tok = tok.slice(1, -1).replace(/\\(["'\\])/g, '$1');
    }
    tokens.push(tok);
  }
  return tokens;
}

function parseFlags(tokens) {
  const args = [];
  const flags = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '--') {
      args.push(...tokens.slice(i + 1));
      break;
    }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq > 2) {
        flags[t.slice(2, eq)] = t.slice(eq + 1);
        continue;
      }
      const key = t.slice(2);
      const next = tokens[i + 1];
      if (next != null && !next.startsWith('-')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (t.startsWith('-') && t.length === 2) {
      const key = t.slice(1);
      const next = tokens[i + 1];
      if (next != null && !next.startsWith('-')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    args.push(t);
  }
  return { args, flags };
}

/**
 * @param {string[]|string} input - argv without node/script, or a single command line
 * @returns {{ name: string, args: string[], flags: object, raw: string, area: string }}
 */
function parseCommand(input) {
  let tokens;
  let raw;
  if (Array.isArray(input)) {
    tokens = input.map(String);
    raw = tokens.join(' ');
  } else {
    raw = stripCommandPrefix(input);
    tokens = tokenize(raw);
  }

  if (!tokens.length) {
    return { name: 'help', args: [], flags: {}, raw: '', area: 'help' };
  }

  // Global flags that may appear first: --json, --server, --help, -h, -V
  const { args: allArgs, flags } = parseFlags(tokens);
  if (flags.help || flags.h) {
    return { name: 'help', args: allArgs, flags, raw, area: 'help' };
  }
  if (flags.version || flags.V) {
    return { name: 'version', args: [], flags, raw, area: 'version' };
  }

  if (!allArgs.length) {
    return { name: 'help', args: [], flags, raw, area: 'help' };
  }

  const name = allArgs[0].toLowerCase();
  const rest = allArgs.slice(1);

  // Nested commands: groups open, members kick, channel list, etc.
  const nestedRoots = new Set([
    'config', 'account', 'settings', 'groups', 'members', 'channel',
    'file', 'vault', 'admin', 'timer', 'upload', 'copy', 'crypto', 'ai',
  ]);

  let commandName = name;
  let commandArgs = rest;
  if (nestedRoots.has(name) && rest.length) {
    const sub = rest[0].toLowerCase();
    // Known multi-word forms
    if (name === 'members' && sub === 'admin' && rest[1]) {
      commandName = `members admin ${rest[1].toLowerCase()}`;
      commandArgs = rest.slice(2);
    } else if (name === 'groups' && sub === 'settings' && rest[1] === 'set') {
      commandName = 'groups settings set';
      commandArgs = rest.slice(2);
    } else if (name === 'groups' && sub === 'keys' && rest[1] === 'sync') {
      commandName = 'groups keys sync';
      commandArgs = rest.slice(2);
    } else if (name === 'admin' && sub === 'user' && rest[1] === 'delete') {
      commandName = 'admin user delete';
      commandArgs = rest.slice(2);
    } else if (name === 'admin' && sub === 'users') {
      commandName = 'admin users';
      commandArgs = rest.slice(1);
    } else {
      commandName = `${name} ${sub}`;
      commandArgs = rest.slice(1);
    }
  }

  // Aliases
  const aliases = {
    q: 'quit',
    exit: 'quit',
    ls: 'groups',
    g: 'groups',
    m: 'members',
    c: 'channel',
    h: 'history',
    s: 'send',
  };
  if (aliases[commandName]) commandName = aliases[commandName];

  const area = commandName.split(' ')[0];
  return {
    name: commandName,
    args: commandArgs,
    flags,
    raw,
    area,
  };
}

function isKnownArea(area) {
  return COMMAND_AREAS.includes(area);
}

function helpText() {
  return `
gchat — encrypted group chat CLI/TUI

Usage:
  gchat                     Launch interactive TUI
  gchat <command> [args]    Run a one-shot command
  gchat help [command]      Show help

Global flags:
  --server <url>   Override server URL
  --json           Machine-readable output where supported
  --yes            Skip confirmation prompts
  -h, --help       Show help
  -V, --version    Show version

Command groups:
  Auth:       login, logout, register, whoami, account, settings
  Groups:     groups, open, join, groups create|join|leave|disband|clear|rename|invite|settings
  Channels:   channel list|switch|create|delete|main
  Messaging:  send, reply, edit, delete, history, read, whisper, disappear, hide, timer
  Members:    members, members kick, members admin grant|revoke, presence
  Files:      upload, file list|save|open
  Search:     search, export, copy
  Session:    connect, disconnect, status, doctor, version, config
  Vault:      vault list|sync|export|import|forget, crypto selftest
  Admin:      admin users (requires adminSecret)
  TUI:        tui, quit, :help, :focus, :bottom, :older, :theme, :bell

Examples:
  gchat login -u alice
  gchat groups create "eng-team"
  gchat join ab12cd
  gchat open eng-team
  gchat send "hello encrypted world"
  gchat history --limit 20
  gchat channel switch design
  gchat whisper bob "secret note"
`.trim();
}

function commandHelp(name) {
  const map = {
    login: 'gchat login [-u user] [-p pass] [--remember]\nAuthenticate and store session cookie.',
    register: 'gchat register [-u user] [-p pass] [--color #hex]\nCreate a new account.',
    groups: 'gchat groups [list|open|create|join|leave|disband|clear|rename|invite|settings|keys|preload|icon|color]\nManage groups and vault keys.',
    send: 'gchat send <text…> [--group name] [--channel name]\nSend encrypted text in the active group/channel.',
    channel: 'gchat channel [list|switch|create|delete|main] [name]\nManage sub-chat channels (default #main).',
    vault: 'gchat vault [list|sync|export|import|forget]\nLocal encryption key vault.',
    doctor: 'gchat doctor\nCheck server health, session, and crypto self-test.',
    history: 'gchat history [--limit n] [--before id] [--group name]\nFetch and decrypt recent messages (max 100).',
    tui: 'gchat tui\nInteractive command-driven terminal UI.',
  };
  return map[name] || helpText();
}

module.exports = {
  COMMAND_AREAS,
  stripCommandPrefix,
  tokenize,
  parseFlags,
  parseCommand,
  isKnownArea,
  helpText,
  commandHelp,
};
