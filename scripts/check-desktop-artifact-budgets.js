'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
if (!root) throw new Error('Artifact directory is required');

const files = fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
  if (!entry.isFile()) return [];
  return [path.join(root, entry.name)];
});

const hasWindowsInstaller = files.some((file) => /Setup.*\.exe$/i.test(path.basename(file)) || /-setup\.exe$/i.test(file));
const hasMacInstaller = files.some((file) => /\.dmg$/i.test(file));
if (!hasWindowsInstaller && !hasMacInstaller) {
  throw new Error('No supported desktop installer found');
}

if (hasWindowsInstaller) {
  // electron-updater publishes latest.yml + blockmap rather than Tauri .sig files
  const hasUpdaterMeta = files.some((file) => /latest\.yml$/i.test(file))
    || files.some((file) => /\.blockmap$/i.test(file))
    || files.some((file) => /\.exe\.sig$/i.test(file));
  if (!hasUpdaterMeta) {
    console.warn('Warning: Windows updater metadata (latest.yml/blockmap) not found in this staging dir');
  }
}

if (hasMacInstaller) {
  const hasZip = files.some((file) => /\.zip$/i.test(file));
  if (!hasZip) {
    console.warn('Warning: macOS zip updater payload not found in this staging dir');
  }
}

// Electron NSIS includes Chromium (~70–100 MiB). Tauri fallback stays under 15 MiB.
const budgets = [
  { pattern: /Setup.*\.exe$/i, maxBytes: 120 * 1024 * 1024, label: 'Windows Electron installer' },
  { pattern: /-setup\.exe$/i, maxBytes: 15 * 1024 * 1024, label: 'Windows Tauri fallback installer' },
  { pattern: /\.dmg$/i, maxBytes: 150 * 1024 * 1024, label: 'macOS DMG' },
];

for (const budget of budgets) {
  const matches = files.filter((file) => budget.pattern.test(path.basename(file)));
  for (const file of matches) {
    const size = fs.statSync(file).size;
    console.log(`${budget.label}: ${(size / 1024 / 1024).toFixed(2)} MiB (${path.basename(file)})`);
    if (size > budget.maxBytes) {
      throw new Error(`${budget.label} exceeds ${(budget.maxBytes / 1024 / 1024).toFixed(0)} MiB budget`);
    }
  }
}
