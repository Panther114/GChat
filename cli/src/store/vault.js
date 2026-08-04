'use strict';

const { configPaths, readJson, writeJson } = require('./paths');

function loadVault(paths) {
  const p = paths || configPaths();
  const data = readJson(p.vault, { entries: {} });
  return data.entries && typeof data.entries === 'object' ? data.entries : {};
}

function saveVault(entries, paths) {
  const p = paths || configPaths();
  writeJson(p.vault, { entries: entries || {} });
  return entries;
}

function putVaultEntry(groupId, entry, paths) {
  const entries = loadVault(paths);
  entries[String(groupId)] = {
    groupId: String(groupId),
    secret: entry.secret,
    joinCode: entry.joinCode || null,
    encryptionVersion: entry.encryptionVersion || 2,
  };
  saveVault(entries, paths);
  return entries[String(groupId)];
}

function getVaultEntry(groupId, paths) {
  const entries = loadVault(paths);
  return entries[String(groupId)] || null;
}

function removeVaultEntry(groupId, paths) {
  const entries = loadVault(paths);
  delete entries[String(groupId)];
  saveVault(entries, paths);
  return entries;
}

function listVaultEntries(paths) {
  return Object.values(loadVault(paths));
}

module.exports = {
  loadVault,
  saveVault,
  putVaultEntry,
  getVaultEntry,
  removeVaultEntry,
  listVaultEntries,
};
