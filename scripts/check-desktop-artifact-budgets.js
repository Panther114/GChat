'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
if (!root) throw new Error('Artifact directory is required');

const files = fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
  if (!entry.isFile()) return [];
  return [path.join(root, entry.name)];
});

const hasWindowsInstaller = files.some((file) => /setup\.exe$/i.test(path.basename(file)));
const hasMacInstaller = files.some((file) => /\.dmg$/i.test(file));
if (!hasWindowsInstaller && !hasMacInstaller) {
  throw new Error('No supported desktop installer found');
}

// Thin wry shell should stay very small; Tauri fallback under 15 MiB; Electron experimental larger.
const budgets = [
  { pattern: /Gchat_.*_x64-setup\.exe$/i, maxBytes: 8 * 1024 * 1024, label: 'Windows thin shell installer' },
  { pattern: /-setup\.exe$/i, maxBytes: 15 * 1024 * 1024, label: 'Windows Tauri installer' },
  { pattern: /Setup-.*\.exe$/i, maxBytes: 120 * 1024 * 1024, label: 'Windows Electron legacy installer' },
  { pattern: /\.dmg$/i, maxBytes: 30 * 1024 * 1024, label: 'macOS DMG' },
];

const seen = new Set();
for (const budget of budgets) {
  for (const file of files) {
    const name = path.basename(file);
    if (!budget.pattern.test(name) || seen.has(file)) continue;
    // Prefer the most specific budget: thin pattern first
    if (budget.label.includes('Tauri') && /Gchat_.*_x64-setup\.exe$/i.test(name)) continue;
    seen.add(file);
    const size = fs.statSync(file).size;
    console.log(`${budget.label}: ${(size / 1024 / 1024).toFixed(2)} MiB (${name})`);
    if (size > budget.maxBytes) {
      throw new Error(`${budget.label} exceeds ${(budget.maxBytes / 1024 / 1024).toFixed(0)} MiB budget`);
    }
  }
}
