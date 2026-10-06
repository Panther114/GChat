'use strict';

const { configPaths } = require('../store/paths');
const { loadConfig } = require('../store/config');

/** Escape sequences that undo everything the UI turns on. */
const RESTORE = '\u001b[?1000l\u001b[?1006l\u001b[?2004l\u001b[?1004l\u001b[?25h\u001b[0m';

/** Starts the inline TUI. Resolves when the user quits. */
async function runInline({ paths, server } = {}) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) {
    stdout.write('GChat needs an interactive terminal. Run "gchat --help" for one-shot commands.\n');
    return;
  }
  const { GChatClient } = require('../client/api');
  const { App } = require('./app');
  const resolvedPaths = paths || configPaths();
  const client = new GChatClient({ server: server || loadConfig(resolvedPaths).server, paths: resolvedPaths });

  const restoreTerminal = () => {
    try { stdout.write(RESTORE); } catch { /* the terminal may already be gone */ }
    try { if (stdin.setRawMode) stdin.setRawMode(false); } catch { /* ignore */ }
  };

  await new Promise((resolve) => {
    const app = new App({
      client,
      paths: resolvedPaths,
      stdin,
      stdout,
      onExit: () => resolve(),
    });

    // Whatever goes wrong, the user's terminal must come back usable.
    const onCrash = (err) => {
      try { app.stop(1); } catch { /* ignore */ }
      restoreTerminal();
      stdout.write(`\ngchat hit an unexpected error and had to stop:\n${(err && err.stack) || err}\n`);
      process.exitCode = 1;
      resolve();
    };
    const onRejection = (reason) => {
      // A failed request or handler should not take the whole UI down.
      app.flash(`Something went wrong: ${(reason && reason.message) || reason}`, 'error', 6000);
    };
    const onSignal = () => app.stop(0);

    process.on('uncaughtException', onCrash);
    process.on('unhandledRejection', onRejection);
    process.once('SIGTERM', onSignal);
    process.once('SIGHUP', onSignal);
    process.once('exit', restoreTerminal);

    app.start().catch(onCrash);
  });

  restoreTerminal();
}

module.exports = { runInline, RESTORE };
