'use strict';

const runtime = require('./src/server/runtime');

if (require.main === module) {
  runtime.startServer().catch((error) => {
    console.error('Failed to start GChat:', error);
    process.exitCode = 1;
  });
}

module.exports = runtime;
