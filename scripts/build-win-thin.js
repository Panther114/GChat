'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const desk = path.join(root, 'src-desktop-win');
const releaseDir = path.join(desk, 'target', 'release');
const bundleDir = path.join(releaseDir, 'bundle');
const exe = path.join(releaseDir, 'Gchat.exe');
const nsi = path.join(root, 'scripts', 'nsis', 'gchat-thin.nsi');

console.log('Building thin Windows shell…');
execFileSync('cargo', ['build', '--release'], {
  cwd: desk,
  stdio: 'inherit',
  shell: true,
});

if (!fs.existsSync(exe)) {
  throw new Error(`Missing binary: ${exe}`);
}

fs.mkdirSync(bundleDir, { recursive: true });

const makensis =
  process.env.MAKENSIS
  || ['C:\\Program Files (x86)\\NSIS\\makensis.exe', 'C:\\Program Files\\NSIS\\makensis.exe']
    .find((p) => fs.existsSync(p));

if (!makensis) {
  throw new Error('makensis.exe not found; install NSIS or set MAKENSIS');
}

console.log('Packaging NSIS installer…');
const result = spawnSync(makensis, ['/V2', nsi], {
  cwd: root,
  encoding: 'utf8',
  shell: false,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) {
  throw new Error(`makensis failed with code ${result.status}`);
}

const setup = path.join(bundleDir, 'Gchat_1.3.10_x64-setup.exe');
if (!fs.existsSync(setup)) {
  // NSIS OutFile is relative to the nsi file location
  const alt = path.join(root, 'src-desktop-win', 'target', 'release', 'bundle', 'Gchat_1.3.10_x64-setup.exe');
  if (fs.existsSync(alt)) {
    console.log(`Installer: ${alt} (${(fs.statSync(alt).size / 1024 / 1024).toFixed(2)} MiB)`);
  } else {
    throw new Error('Installer not produced');
  }
} else {
  console.log(`Installer: ${setup} (${(fs.statSync(setup).size / 1024 / 1024).toFixed(2)} MiB)`);
}

console.log('Thin Windows desktop package ready.');
