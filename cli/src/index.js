'use strict';

const { runArgv } = require('./commands/handlers');
const { parseCommand, helpText } = require('./commands/parser');
const { runTui } = require('./tui/app');
const { CLI_NAME, CLI_VERSION } = require('./version');

async function main(argv = process.argv.slice(2)) {
  // Fast path for help/version without loading network stacks unnecessarily still ok
  if (argv.includes('-h') || argv.includes('--help')) {
    if (argv.filter((a) => !a.startsWith('-')).length <= 1) {
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

  const result = await runArgv(argv);

  if (result && result.__tui) {
    await runTui(result.ctx ? { paths: result.ctx.paths, server: result.ctx.client.server } : {});
    return;
  }
}

module.exports = {
  main,
  parseCommand,
  helpText,
  CLI_NAME,
  CLI_VERSION,
};
