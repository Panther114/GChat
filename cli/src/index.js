'use strict';

const { CLI_NAME, CLI_VERSION } = require('./version');

async function main(argv = process.argv.slice(2)) {
  // Fast path for help/version without loading network stacks or the TUI.
  if (argv.includes('-h') || argv.includes('--help')) {
    if (argv.filter((a) => !a.startsWith('-')).length <= 1) {
      const { helpText } = require('./commands/parser');
      process.stdout.write(`${helpText()}\n`);
      return;
    }
  }
  if (argv.includes('-V') || argv.includes('--version')) {
    if (argv.length === 1 || (argv.length === 1 && (argv[0] === '-V' || argv[0] === '--version'))) {
      process.stdout.write(`${CLI_NAME} ${CLI_VERSION}\n`);
      return;
    }
  }

  // Bare `gchat` is the TUI. Skip the command stack (socket.io, crypto,
  // HTTP client) so the first landing frame can paint immediately.
  if (!argv || argv.length === 0) {
    const { runTui } = require('./tui/app');
    await runTui();
    return;
  }

  const { runArgv } = require('./commands/handlers');
  const { runTui } = require('./tui/app');
  const result = await runArgv(argv);

  if (result && result.__tui) {
    await runTui(result.ctx ? { paths: result.ctx.paths, server: result.ctx.client.server } : {});
  }
}

const { parseCommand, helpText } = require('./commands/parser');

module.exports = {
  main,
  parseCommand,
  helpText,
  CLI_NAME,
  CLI_VERSION,
};
