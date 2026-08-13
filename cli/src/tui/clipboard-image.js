'use strict';

/**
 * Read an image from the OS clipboard or recognize a pasted file path.
 * Zero npm deps: Bun.Image when present, otherwise macOS osascript.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

function looksLikeImagePath(text) {
  const raw = String(text || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw || raw.includes('\n') || raw.length > 512) return false;
  if (!IMAGE_EXT.test(raw)) return false;
  const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  try {
    return fs.existsSync(expanded) && fs.statSync(expanded).isFile() ? expanded : false;
  } catch {
    return false;
  }
}

async function readBunClipboard() {
  if (typeof Bun === 'undefined' || !Bun.Image || typeof Bun.Image.fromClipboard !== 'function') {
    return null;
  }
  try {
    const img = Bun.Image.fromClipboard();
    if (!img) return null;
    const bytes = Buffer.from(await img.png().bytes());
    if (!bytes.length) return null;
    return { bytes, filename: 'paste.png', mimeType: 'image/png' };
  } catch {
    return null;
  }
}

function readMacClipboardPng() {
  if (process.platform !== 'darwin') return null;
  const dest = path.join(os.tmpdir(), `gchat-clip-${process.pid}.png`);
  const escaped = dest.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = [
    'try',
    '  set pngData to the clipboard as «class PNGf»',
    `  set outFile to open for access POSIX file "${escaped}" with write permission`,
    '  set eof of outFile to 0',
    '  write pngData to outFile',
    '  close access outFile',
    '  return "ok"',
    'on error',
    '  try',
    `    close access POSIX file "${escaped}"`,
    '  end try',
    '  return "empty"',
    'end try',
  ].join('\n');
  const result = spawnSync('osascript', ['-e', script], {
    encoding: 'utf8',
    timeout: 4000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || !String(result.stdout || '').includes('ok')) return null;
  try {
    if (!fs.existsSync(dest)) return null;
    const bytes = fs.readFileSync(dest);
    fs.unlinkSync(dest);
    if (!bytes.length) return null;
    return { bytes, filename: 'paste.png', mimeType: 'image/png' };
  } catch {
    try { fs.unlinkSync(dest); } catch { /* ignore */ }
    return null;
  }
}

async function readClipboardImage() {
  return (await readBunClipboard()) || readMacClipboardPng();
}

module.exports = {
  IMAGE_EXT,
  looksLikeImagePath,
  readClipboardImage,
};
