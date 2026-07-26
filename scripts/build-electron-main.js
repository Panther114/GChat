'use strict';

const esbuild = require('esbuild');

const fs = require('fs');
const zlib = require('zlib');

const bundles = [
  {
    entryPoint: 'electron/main.js',
    outfile: 'electron/main.bundle.cjs',
    maxBytes: 32 * 1024,
  },
  {
    entryPoint: 'electron/updater.js',
    outfile: 'electron/updater.bundle.cjs',
    maxBytes: 320 * 1024,
  },
];

for (const bundle of bundles) {
  esbuild.buildSync({
    entryPoints: [bundle.entryPoint],
    bundle: true,
    external: ['electron', './updater.bundle.cjs'],
    format: 'cjs',
    legalComments: 'none',
    minify: true,
    outfile: bundle.outfile,
    platform: 'node',
    target: 'node20',
  });

  const output = fs.readFileSync(bundle.outfile);
  if (output.length > bundle.maxBytes) {
    throw new Error(`${bundle.outfile} exceeds its ${bundle.maxBytes}-byte performance budget (${output.length} bytes).`);
  }
  console.log(`${bundle.outfile}: ${output.length} bytes (${zlib.gzipSync(output).length} gzip)`);
}
