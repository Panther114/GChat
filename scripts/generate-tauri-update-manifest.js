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

// v1.3.9: tolerate a missing platform instead of failing the whole release —
// the thin Windows shell does not use latest.json (it checks the GitHub API),
// so a release without a Windows .sig can still publish macOS update metadata.
function signedPlatform(artifact) {
  const signaturePath = `${artifact}.sig`;
  if (!fs.existsSync(signaturePath)) return null;
  const name = path.basename(artifact);
  return {
    signature: fs.readFileSync(signaturePath, 'utf8').trim(),
    url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}`,
  };
}

const windows = windowsArtifact ? signedPlatform(windowsArtifact) : null;
const mac = macArtifact ? signedPlatform(macArtifact) : null;
if (!windows && !mac) {
  fail('No signed updater artifacts found (need at least one of: -setup.exe.sig, .app.tar.gz.sig)');
}

const platforms = {};
if (mac) {
  platforms['darwin-aarch64'] = mac;
  platforms['darwin-x86_64'] = mac;
}
if (windows) {
  platforms['windows-x86_64'] = windows;
}
const manifest = {
  version,
  notes: `Gchat ${version}`,
  pub_date: new Date().toISOString(),
  platforms,
};

fs.writeFileSync(path.join(releaseDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

