'use strict';

const { parseEscrowMasterKey } = require('./group-key-escrow');

const CRYPTO_EPOCH = 2;
const ENCRYPTION_VERSION = 2;
const KEY_VERSION = 1;
const AI_TEMPORARILY_DISABLED = true;

function readConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production' || env.RAILWAY_ENVIRONMENT != null;
  const groupCodePepper = String(env.GROUP_CODE_PEPPER || env.SESSION_SECRET || '').trim();
  if (isProduction && groupCodePepper.length < 32) {
    throw new Error('GROUP_CODE_PEPPER or SESSION_SECRET must be at least 32 characters in production');
  }
  const groupKeyEscrowMasterKey = parseEscrowMasterKey(env.GROUP_KEY_ESCROW_MASTER_KEY);
  return Object.freeze({
    aiEnabled: !AI_TEMPORARILY_DISABLED && env.AI_ENABLED === '1',
    cryptoEpoch: CRYPTO_EPOCH,
    encryptionVersion: ENCRYPTION_VERSION,
    groupCodePepper: groupCodePepper || 'gchat-local-development-pepper-change-before-production',
    groupKeyEscrowMasterKey,
    isProduction,
    keyVersion: KEY_VERSION,
    localDebugEnabled: env.GCHAT_LOCAL_DEBUG === '1',
    maintenanceMode: env.MAINTENANCE_MODE === '1',
  });
}

module.exports = {
  CRYPTO_EPOCH,
  ENCRYPTION_VERSION,
  KEY_VERSION,
  readConfig,
};
