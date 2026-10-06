'use strict';

const { spawn } = require('node:child_process');
const esbuild = require('esbuild');

const shared = { bundle: true, sourcemap: true };

// Throwaway secrets so `npm run dev:web` boots on a fresh checkout. Real
// values from the environment always win; these never apply to production.
const DEV_SECRETS = {
  SESSION_SECRET: 'dev-only-session-secret-0123456789abcdef',
  GROUP_CODE_PEPPER: 'dev-only-group-code-pepper-0123456789',
  GROUP_KEY_ESCROW_MASTER_KEY: Buffer.alloc(32, 9).toString('base64url'),
};

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

  const child = spawn(process.execPath, ['server.js'], { env: { ...DEV_SECRETS, ...process.env }, stdio: 'inherit' });
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
