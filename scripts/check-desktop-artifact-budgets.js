'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
if (!root) throw new Error('Artifact directory is required');

const files = fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
  if (!entry.isFile()) return [];
  return [path.join(root, entry.name)];
});

const budgets = [
  { pattern: /-setup\.exe$/i, maxBytes: 15 * 1024 * 1024, label: 'Windows installer' },
  { pattern: /\.dmg$/i, maxBytes: 30 * 1024 * 1024, label: 'macOS universal DMG' },
];

for (const budget of budgets) {
  const matches = files.filter((file) => budget.pattern.test(file));
  if (matches.length === 0) continue;
  for (const file of matches) {
    const size = fs.statSync(file).size;
    console.log(`${budget.label}: ${(size / 1024 / 1024).toFixed(2)} MiB`);
    if (size > budget.maxBytes) {
      throw new Error(`${budget.label} exceeds ${(budget.maxBytes / 1024 / 1024).toFixed(0)} MiB budget`);
    }
  }
}

