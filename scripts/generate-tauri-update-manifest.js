'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  throw new Error(message);
}

function walk(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

const [releaseDir, tag, repository] = process.argv.slice(2);
if (!releaseDir || !tag || !repository) {
  fail('Usage: node scripts/generate-tauri-update-manifest.js <release-dir> <tag> <owner/repo>');
}

const version = tag.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`Invalid release tag: ${tag}`);

const files = walk(releaseDir);
const windowsArtifact = files.find((file) => /-setup\.exe$/i.test(file));
const macArtifact = files.find((file) => /\.app\.tar\.gz$/i.test(file));
if (!windowsArtifact) fail('Missing Windows updater installer');
if (!macArtifact) fail('Missing macOS updater archive');

function signedPlatform(artifact) {
  const signaturePath = `${artifact}.sig`;
  if (!fs.existsSync(signaturePath)) fail(`Missing updater signature: ${signaturePath}`);
  const name = path.basename(artifact);
  return {
    signature: fs.readFileSync(signaturePath, 'utf8').trim(),
    url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}`,
  };
}

const windows = signedPlatform(windowsArtifact);
const mac = signedPlatform(macArtifact);
const manifest = {
  version,
  notes: `Gchat ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'darwin-aarch64': mac,
    'darwin-x86_64': mac,
    'windows-x86_64': windows,
  },
};

fs.writeFileSync(path.join(releaseDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

