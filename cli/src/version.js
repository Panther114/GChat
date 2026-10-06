'use strict';

// Plain require so bundlers (bun compile) inline package.json; reading it with
// fs would fail inside a standalone binary and report 0.0.0.
function readCliVersion() {
  try {
    return String(require('../package.json').version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

const CLI_NAME = 'gchat';
const CLI_VERSION = readCliVersion();
const DEFAULT_SERVER = 'https://gchat.up.railway.app';
/** Must match server `SYNC_PROTOCOL_VERSION`. Hosted production 426s without it. */
const SYNC_PROTOCOL_VERSION = 2;
const SYNC_PROTOCOL_HEADER = 'X-GChat-Sync-Protocol';

module.exports = {
  CLI_NAME,
  CLI_VERSION,
  DEFAULT_SERVER,
  SYNC_PROTOCOL_VERSION,
  SYNC_PROTOCOL_HEADER,
};
