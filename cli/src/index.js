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

  // Bare `gchat` (optionally with --server <url>) opens the TUI. Skip the
  // command stack so the first frame paints immediately.
  const { positional, server, classic } = splitGlobals(argv);
  if (positional.length === 0 || (positional.length === 1 && positional[0] === 'tui')) {
    await launchTui({ server, classic });
    return;
  }

  const { runArgv } = require('./commands/handlers');
  const result = await runArgv(argv);

  if (result && result.__tui) {
    await launchTui({
      server: result.ctx ? result.ctx.client.server : server,
      paths: result.ctx ? result.ctx.paths : undefined,
      classic,
    });
  }
}

/** Separates the TUI launch flags from positional arguments. */
function splitGlobals(argv) {
  const positional = [];
  let server = null;
  let classic = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--server' && argv[i + 1]) {
      server = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--server=')) {
      server = arg.slice('--server='.length);
    } else if (arg === '--classic') {
      classic = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, server, classic };
}

async function launchTui({ server, paths, classic }) {
  if (classic) {
    const { runTui } = require('./tui/app');
    await runTui({ server: server || undefined, paths });
    return;
  }
  const { runInline } = require('./ui');
  await runInline({ server: server || undefined, paths });
}

const { parseCommand, helpText } = require('./commands/parser');

module.exports = {
  main,
  parseCommand,
  helpText,
  CLI_NAME,
  CLI_VERSION,
};
