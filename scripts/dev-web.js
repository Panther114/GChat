'use strict';

const { spawn } = require('node:child_process');
const esbuild = require('esbuild');

const shared = { bundle: true, sourcemap: true };

async function main() {
  const contexts = await Promise.all([
    esbuild.context({ ...shared, entryPoints: ['src/web/app-entry.js'], format: 'iife', platform: 'browser', target: ['es2022'], outfile: 'public/app.js' }),
    esbuild.context({
      ...shared,
      entryPoints: ['src/styles/index.css'],
      outfile: 'public/style.css',
      external: ['Botanical.otf?v=20260512', 'Roca-Regular.ttf?v=20260512', 'gchat_wallpaper.jpg'],
    }),
  ]);
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching modular web assets for changes.');

  const child = spawn(process.execPath, ['server.js'], { env: process.env, stdio: 'inherit' });
  const shutdown = async () => {
    if (!child.killed) child.kill();
    await Promise.all(contexts.map((context) => context.dispose()));
  };
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(130)));
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(143)));
  child.once('exit', (code) => void shutdown().finally(() => { process.exitCode = code ?? 1; }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
