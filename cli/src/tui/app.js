'use strict';

const readline = require('node:readline');
const { parseCommand } = require('../commands/parser');
const { handleCommand, createContext } = require('../commands/handlers');
const { formatMessageLine } = require('../client/messages');
const { loadPrefs } = require('../store/prefs');
const { getActiveChannel } = require('../store/prefs');
const { CLI_NAME, CLI_VERSION } = require('../version');

/**
 * Command-driven terminal UI.
 * Layout is redrawn text; all actions go through the shared command handlers.
 */
async function runTui(options = {}) {
  const outputLines = [];
  const maxLog = 200;
  let status = 'starting';
  let lastError = '';
  let running = true;

  const pushLog = (line) => {
    const text = String(line);
    for (const part of text.split('\n')) {
      outputLines.push(part);
    }
    while (outputLines.length > maxLog) outputLines.shift();
  };

  const ctx = createContext({
    ...options,
    out: (text) => pushLog(text),
    err: (text) => {
      lastError = String(text);
      pushLog(`! ${text}`);
    },
    onEvent: (event, payload) => {
      if (event === 'new_message' && payload) {
        handleIncoming(payload).catch(() => {});
      } else if (event === 'connect') {
        status = 'connected';
        render();
      } else if (event === 'disconnect') {
        status = 'disconnected';
        render();
      } else if (event === 'typing' && payload) {
        status = `typing…`;
        render();
      } else if (event === 'error') {
        lastError = payload?.message || String(payload);
        render();
      }
    },
  });

  // Wire socket events through client
  ctx.client.onEvent = (event, payload) => {
    if (event === 'new_message' && payload) {
      handleIncoming(payload).catch(() => {});
    } else if (event === 'connect') {
      status = 'connected';
      render();
    } else if (event === 'disconnect') {
      status = 'disconnected';
      render();
    }
  };

  async function handleIncoming(msg) {
    try {
      const secret = ctx.client.getSecret(msg.groupId);
      if (!secret) return;
      const [dec] = await ctx.client.decryptMessages(msg.groupId, [msg]);
      const prefs = loadPrefs(ctx.paths);
      if (prefs.muteAll || prefs.mutedGroups?.[msg.groupId]) return;
      const active = prefs.activeGroupId;
      if (active && String(msg.groupId) !== String(active)) {
        pushLog(`* [${msg.senderName || '?'} in ${msg.groupId.slice(0, 8)}…] ${dec.text || '[msg]'}`);
      } else {
        pushLog(formatMessageLine(msg, dec));
      }
      const config = require('../store/config').loadConfig(ctx.paths);
      if (config.bell && process.stdout.isTTY) {
        process.stdout.write('\u0007');
      }
      render();
    } catch {
      /* ignore decrypt failures for noise */
    }
  }

  function header() {
    const prefs = loadPrefs(ctx.paths);
    const user = ctx.client.user?.username || '(not logged in)';
    const group = prefs.activeGroupId ? prefs.activeGroupId.slice(0, 8) : '-';
    const channel = prefs.activeGroupId ? getActiveChannel(prefs.activeGroupId, ctx.paths) : 'main';
    return [
      `══ ${CLI_NAME} ${CLI_VERSION} ════════════════════════════════════════`,
      `user=${user}  group=${group}  #${channel}  socket=${status}  server=${ctx.client.server}`,
      lastError ? `error: ${lastError}` : 'commands: :help  :groups  :open <name>  :send …  :q',
      '────────────────────────────────────────────────────────────────',
    ].join('\n');
  }

  function render() {
    if (!process.stdout.isTTY) return;
    // Soft redraw: print header + last lines (avoid full clear flicker for basic terminals)
    // Full clear when interactive
    try {
      readline.cursorTo(process.stdout, 0, 0);
      readline.clearScreenDown(process.stdout);
    } catch {
      /* non-tty */
    }
    const visible = outputLines.slice(-Math.max(8, (process.stdout.rows || 24) - 8));
    process.stdout.write(`${header()}\n${visible.join('\n')}\n`);
  }

  pushLog(`${CLI_NAME} TUI — type messages to send, or :command for actions. :q to quit.`);
  pushLog('Try: :login  |  :groups  |  :open <name>  |  :channel list  |  :help');

  // Session restore
  try {
    const me = await ctx.client.me();
    pushLog(`Session restored: ${me.username}`);
    await ctx.client.syncKeys().catch(() => {});
    const prefs = loadPrefs(ctx.paths);
    if (prefs.activeGroupId) {
      try {
        const opened = await ctx.client.openGroup(prefs.activeGroupId);
        pushLog(`Reopened ${opened.group.name} #${opened.channel}`);
        const decrypted = await ctx.client.decryptMessages(opened.group.id, opened.messages);
        for (const d of decrypted.slice(-20)) {
          pushLog(formatMessageLine(d.msg, d));
        }
        status = 'connected';
      } catch (err) {
        pushLog(`Could not reopen group: ${err.message}`);
      }
    }
  } catch {
    pushLog('Not logged in. Use :login');
  }

  render();

  if (!process.stdin.isTTY) {
    pushLog('No TTY — exiting TUI. Use subcommands instead.');
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'gchat> ',
    terminal: true,
  });

  const runLine = async (line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    // Colon or slash command
    if (trimmed.startsWith(':') || trimmed.startsWith('/')) {
      const body = trimmed.slice(1).trim();
      if (body === 'q' || body === 'quit' || body === 'exit') {
        running = false;
        rl.close();
        return;
      }
      if (body === 'redraw' || body === 'clear') {
        render();
        rl.prompt();
        return;
      }
      try {
        const parsed = parseCommand(body);
        if (parsed.name === 'tui') {
          pushLog('Already in TUI');
        } else if (parsed.name === 'quit') {
          running = false;
          rl.close();
          return;
        } else {
          lastError = '';
          await handleCommand(parsed, ctx);
        }
      } catch (err) {
        lastError = err.message || String(err);
        pushLog(`! ${lastError}`);
      }
      render();
      if (running) rl.prompt();
      return;
    }

    // Bare text = send to active group
    try {
      const prefs = loadPrefs(ctx.paths);
      if (!prefs.activeGroupId) {
        pushLog('! No active group. :open <name> or :groups create <name>');
      } else {
        const result = await ctx.client.sendText({
          groupId: prefs.activeGroupId,
          text: trimmed,
        });
        pushLog(`you: ${trimmed}  (${result.messageId.slice(0, 8)}…)`);
      }
    } catch (err) {
      lastError = err.message || String(err);
      pushLog(`! ${lastError}`);
    }
    render();
    if (running) rl.prompt();
  };

  rl.on('line', (line) => {
    runLine(line).catch((err) => {
      pushLog(`! ${err.message}`);
      render();
      if (running) rl.prompt();
    });
  });

  rl.on('close', () => {
    running = false;
    ctx.client.disconnectSocket();
    process.stdout.write('\nbye\n');
  });

  rl.prompt();

  // Keep process alive until readline closes
  await new Promise((resolve) => {
    rl.on('close', resolve);
  });
}

module.exports = {
  runTui,
};
