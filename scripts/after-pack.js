'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const WINDOWS_OPTIONAL_GPU_FILES = Object.freeze([
  'dxcompiler.dll',
  'dxil.dll',
]);

async function removeOptionalWindowsGpuFiles(appOutDir) {
  const outputRoot = path.resolve(appOutDir);
  let reclaimedBytes = 0;

  for (const filename of WINDOWS_OPTIONAL_GPU_FILES) {
    const target = path.resolve(outputRoot, filename);
    if (path.dirname(target) !== outputRoot) {
      throw new Error(`Refusing to remove a file outside the packaged app root: ${target}`);
    }

    try {
      const stat = await fs.stat(target);
      await fs.rm(target);
      reclaimedBytes += stat.size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  return reclaimedBytes;
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const reclaimedBytes = await removeOptionalWindowsGpuFiles(context.appOutDir);
  console.log(`Removed ${reclaimedBytes} bytes of disabled WebGPU compiler binaries.`);
}

module.exports = afterPack;
module.exports.WINDOWS_OPTIONAL_GPU_FILES = WINDOWS_OPTIONAL_GPU_FILES;
module.exports.removeOptionalWindowsGpuFiles = removeOptionalWindowsGpuFiles;
