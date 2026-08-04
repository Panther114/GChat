#!/usr/bin/env node
'use strict';

const { main } = require('../src/index');

main(process.argv.slice(2)).catch((err) => {
  const message = err && err.message ? err.message : String(err);
  process.stderr.write(`gchat: ${message}\n`);
  process.exitCode = typeof err?.exitCode === 'number' ? err.exitCode : 1;
});
