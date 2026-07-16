'use strict';

const esbuild = require('esbuild');

esbuild.buildSync({
  entryPoints: ['electron/main.js'],
  bundle: true,
  external: ['electron'],
  format: 'cjs',
  legalComments: 'none',
  minify: true,
  outfile: 'electron/main.bundle.cjs',
  platform: 'node',
  target: 'node20',
});
