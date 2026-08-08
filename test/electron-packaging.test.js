'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  WINDOWS_OPTIONAL_GPU_FILES,
  removeOptionalWindowsGpuFiles,
} = require('../scripts/after-pack');
const packageJson = require('../package.json');

test('desktop packaging removes only the disabled WebGPU compiler binaries', async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gchat-after-pack-'));
  t.after(() => fs.rm(outputRoot, { force: true, recursive: true }));

  const retainedFile = path.join(outputRoot, 'ffmpeg.dll');
  await fs.writeFile(retainedFile, Buffer.alloc(7));
  for (const filename of WINDOWS_OPTIONAL_GPU_FILES) {
    await fs.writeFile(path.join(outputRoot, filename), Buffer.alloc(11));
  }

  const reclaimedBytes = await removeOptionalWindowsGpuFiles(outputRoot);

  assert.equal(reclaimedBytes, WINDOWS_OPTIONAL_GPU_FILES.length * 11);
  assert.equal((await fs.stat(retainedFile)).size, 7);
  for (const filename of WINDOWS_OPTIONAL_GPU_FILES) {
    await assert.rejects(fs.stat(path.join(outputRoot, filename)), { code: 'ENOENT' });
  }
});

test('macOS packaging produces universal installer and updater targets', () => {
  assert.equal(packageJson.build.mac.artifactName, 'Gchat-${version}-mac-${arch}.${ext}');
  assert.deepEqual(packageJson.build.mac.target, [
    { target: 'dmg', arch: ['universal'] },
    { target: 'zip', arch: ['universal'] },
  ]);
  assert.equal(packageJson.build.publish.provider, 'github');
});

test('Windows installer artifact naming stays stable for updater clients', () => {
  assert.equal(packageJson.build.win.artifactName, 'Gchat-Setup-${version}.${ext}');
  assert.equal(packageJson.version, '1.3.14');
  assert.ok(packageJson.build.files.includes('electron/main.bundle.cjs'));
  assert.ok(packageJson.build.files.includes('electron/preload.js'));
});
