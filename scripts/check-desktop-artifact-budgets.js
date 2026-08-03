'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
if (!root) throw new Error('Artifact directory is required');

const files = fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
  if (!entry.isFile()) return [];
  return [path.join(root, entry.name)];
});

function requireArtifact(pattern, label) {
  if (!files.some((file) => pattern.test(file))) {
    throw new Error(`Missing ${label}`);
  }
}

const hasWindowsInstaller = files.some((file) => /-setup\.exe$/i.test(file) || /Setup.*\.exe$/i.test(path.basename(file)));
const hasMacInstaller = files.some((file) => /\.dmg$/i.test(file));
if (!hasWindowsInstaller && !hasMacInstaller) {
  throw new Error('No supported desktop installer found');
}

if (hasWindowsInstaller) {
  // Prefer Tauri signed artifacts; Electron blockmap is optional legacy only.
  const hasTauriSig = files.some((file) => /\.exe\.sig$/i.test(file));
  const hasElectronMeta = files.some((file) => /latest\.yml$/i.test(file) || /\.blockmap$/i.test(file));
  if (!hasTauriSig && !hasElectronMeta) {
    throw new Error('Missing Windows updater signature or electron-updater metadata');
  }
  if (hasTauriSig) {
    requireArtifact(/-setup\.exe\.sig$/i, 'Windows updater signature');
  }
}

if (hasMacInstaller) {
  const hasTar = files.some((file) => /\.app\.tar\.gz$/i.test(file));
  const hasZip = files.some((file) => /\.zip$/i.test(file));
  if (hasTar) {
    requireArtifact(/\.app\.tar\.gz\.sig$/i, 'macOS updater signature');
  } else if (!hasZip) {
    console.warn('Warning: macOS updater archive not found in this staging dir');
  }
}

// Tauri/WebView2 installers stay small; Electron legacy path is larger.
const budgets = [
  { pattern: /-setup\.exe$/i, maxBytes: 15 * 1024 * 1024, label: 'Windows Tauri installer' },
  { pattern: /Setup-.*\.exe$/i, maxBytes: 120 * 1024 * 1024, label: 'Windows Electron legacy installer' },
  { pattern: /\.dmg$/i, maxBytes: 30 * 1024 * 1024, label: 'macOS universal DMG' },
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
