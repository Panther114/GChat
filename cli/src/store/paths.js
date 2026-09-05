'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolveConfigDir(overrideDir) {
  if (overrideDir) return path.resolve(overrideDir);
  if (process.env.GCHAT_CONFIG_DIR) return path.resolve(process.env.GCHAT_CONFIG_DIR);
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'gchat');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'gchat');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function configPaths(overrideDir) {
  const root = ensureDir(resolveConfigDir(overrideDir));
  return {
    root,
    config: path.join(root, 'config.json'),
    session: path.join(root, 'session.json'),
    prefs: path.join(root, 'prefs.json'),
    vault: path.join(root, 'vault.json'),
  };
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // A corrupted store file must not silently empty the vault/config; say so.
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) {
        process.stderr.write(`gchat: warning: could not parse ${file} (${err.message}); ignoring its contents\n`);
      }
    } catch {
      /* file vanished between the two reads */
    }
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows may ignore mode */
  }
}

module.exports = {
  resolveConfigDir,
  ensureDir,
  configPaths,
  readJson,
  writeJson,
};
