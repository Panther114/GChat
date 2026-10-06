'use strict';

const { configPaths } = require('../store/paths');
const { loadConfig } = require('../store/config');

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
  await new Promise((resolve) => {
    const app = new App({ client, paths: resolvedPaths, stdin, stdout, onExit: () => resolve() });
    process.once('SIGTERM', () => app.stop(0));
    app.start().catch((err) => {
      stdout.write(`\ngchat: ${err.message || err}\n`);
      app.stop(1);
    });
  });
}

module.exports = { runInline };
