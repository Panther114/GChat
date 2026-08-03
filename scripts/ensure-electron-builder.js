try {
  require.resolve('electron-builder/package.json');
} catch {
  console.error(
    [
      'electron-builder is not installed.',
      'Run "npm install --include=dev" in the repository root, then try again.',
      'If you already ran npm install, make sure devDependencies were not skipped.'
    ].join('\n')
  );
  process.exit(1);
}
