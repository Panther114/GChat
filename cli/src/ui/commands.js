'use strict';

/**
 * Slash commands for the inline TUI.
 *
 * `native` commands are implemented by the App (they need dialogs, the
 * transcript or the socket). Everything else typed after `/` falls through to
 * the same handlers `gchat <command>` uses, so the full CLI surface works
 * inside the TUI too.
 */

const COMMANDS = [
  { name: 'home', aliases: ['h'], usage: '', desc: 'Back to the home screen', native: 'home' },
  { name: 'groups', aliases: ['g', 'switch'], usage: '', desc: 'Switch between groups', native: 'groups' },
  { name: 'channel', aliases: ['c', 'channels'], usage: '[name | new | delete]', desc: 'Switch, create or delete channels', native: 'channel' },
  { name: 'new', aliases: ['create'], usage: '[name]', desc: 'Create a group', native: 'newGroup' },
  { name: 'join', aliases: [], usage: '[code]', desc: 'Join a group with an invite code', native: 'joinGroup' },
  { name: 'invite', aliases: [], usage: '', desc: 'Show this group’s invite code', native: 'invite' },
  { name: 'members', aliases: ['m'], usage: '', desc: 'List members', native: 'members' },
  { name: 'reply', aliases: ['r'], usage: '', desc: 'Reply to a message', native: 'reply' },
  { name: 'edit', aliases: ['e'], usage: '', desc: 'Edit one of your messages', native: 'edit' },
  { name: 'delete', aliases: ['d'], usage: '', desc: 'Delete one of your messages', native: 'remove' },
  { name: 'upload', aliases: ['image', 'attach'], usage: '<path>', desc: 'Send an image or file', native: 'upload' },
  { name: 'paste', aliases: [], usage: '', desc: 'Send the image on your clipboard', native: 'pasteImage' },
  { name: 'view', aliases: ['v'], usage: '[n]', desc: 'Show an image full size', native: 'view' },
  { name: 'save', aliases: [], usage: '[n] [path]', desc: 'Save an attachment to disk', native: 'save' },
  { name: 'launch', aliases: [], usage: '[n]', desc: 'Open an attachment in the default app', native: 'launch' },
  { name: 'history', aliases: ['older'], usage: '', desc: 'Load earlier messages', native: 'history' },
  { name: 'search', aliases: ['find'], usage: '<text>', desc: 'Search recent messages', native: 'search' },
  { name: 'whisper', aliases: ['w'], usage: '<user> <text>', desc: 'Send a private message', generic: true },
  { name: 'clear', aliases: ['cls'], usage: '', desc: 'Clear the screen', native: 'clearScreen' },
  { name: 'mouse', aliases: [], usage: '[on|off]', desc: 'Turn mouse clicks on or off', native: 'mouse' },
  { name: 'theme', aliases: [], usage: '[dark|light]', desc: 'Switch the color theme', native: 'theme' },
  { name: 'status', aliases: [], usage: '', desc: 'Connection and account info', native: 'status' },
  { name: 'whoami', aliases: [], usage: '', desc: 'Show who you are signed in as', native: 'whoami' },
  { name: 'logout', aliases: ['signout'], usage: '', desc: 'Sign out', native: 'logout' },
  { name: 'export', aliases: [], usage: '[-o file]', desc: 'Export recent messages', generic: true },
  { name: 'vault', aliases: [], usage: 'list | export | import | forget', desc: 'Manage group encryption keys', generic: true },
  { name: 'config', aliases: [], usage: 'get | set <key> <value>', desc: 'View or change settings', generic: true },
  { name: 'doctor', aliases: [], usage: '', desc: 'Check server connectivity', generic: true },
  { name: 'help', aliases: ['?'], usage: '', desc: 'Show all commands', native: 'help' },
  { name: 'quit', aliases: ['exit', 'q'], usage: '', desc: 'Exit GChat', native: 'quit' },
];

const DESTRUCTIVE = new Set([
  'groups leave', 'groups disband', 'groups clear', 'account delete', 'vault forget', 'members kick',
]);

function findCommand(name) {
  const key = String(name || '').toLowerCase();
  return COMMANDS.find((c) => c.name === key || c.aliases.includes(key)) || null;
}

/** Commands matching what the user has typed after the slash (name part only). */
function matchCommands(typed) {
  const key = String(typed || '').toLowerCase();
  if (!key) return COMMANDS.slice();
  const starts = COMMANDS.filter((c) => c.name.startsWith(key) || c.aliases.some((a) => a.startsWith(key)));
  const rest = COMMANDS.filter((c) => !starts.includes(c) && (c.name.includes(key) || c.desc.toLowerCase().includes(key)));
  return [...starts, ...rest];
}

module.exports = { COMMANDS, DESTRUCTIVE, findCommand, matchCommands };
