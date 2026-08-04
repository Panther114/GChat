'use strict';

const path = require('node:path');
const fs = require('node:fs');

function readCliVersion() {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

const CLI_NAME = 'gchat';
const CLI_VERSION = readCliVersion();
const DEFAULT_SERVER = 'https://gchat.up.railway.app';

module.exports = {
  CLI_NAME,
  CLI_VERSION,
  DEFAULT_SERVER,
};
