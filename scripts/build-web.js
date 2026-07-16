'use strict';

const esbuild = require('esbuild');

async function build() {
  await Promise.all([
    esbuild.build({ entryPoints: ['src/web/app-entry.js'], bundle: true, format: 'iife', platform: 'browser', target: ['es2022'], outfile: 'public/app.js', sourcemap: true }),
    esbuild.build({
      entryPoints: ['src/styles/index.css'],
      bundle: true,
      outfile: 'public/style.css',
      sourcemap: true,
      external: ['Botanical.otf?v=20260512', 'Roca-Regular.ttf?v=20260512', 'gchat_wallpaper.jpg'],
    }),
  ]);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
