'use strict';

const { S3Client, HeadObjectCommand, DeleteObjectCommand, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function readBucketConfig(env = process.env) {
  return {
    enabled: env.GCHAT_MEDIA_DIRECT === '1',
    endpoint: env.BUCKET_ENDPOINT || env.AWS_ENDPOINT_URL || env.ENDPOINT || '',
    bucket: env.BUCKET_NAME || env.AWS_S3_BUCKET_NAME || env.BUCKET || '',
    accessKeyId: env.BUCKET_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID || env.ACCESS_KEY_ID || '',
    secretAccessKey: env.BUCKET_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY || env.SECRET_ACCESS_KEY || '',
    region: env.BUCKET_REGION || env.AWS_DEFAULT_REGION || env.REGION || 'auto',
    forcePathStyle: String(env.AWS_S3_URL_STYLE || '').toLowerCase() === 'path',
  };
}

function createMediaStore(env = process.env) {
  const config = readBucketConfig(env);
  const configured = !!(config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey);
  const enabled = config.enabled && configured;
  const client = configured ? new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  }) : null;

  async function signedPut(objectKey, { expiresIn = 300, sha256 } = {}) {
    if (!enabled) throw new Error('Direct media storage is disabled');
    const checksum = sha256 ? Buffer.from(sha256, 'hex').toString('base64') : undefined;
    return getSignedUrl(client, new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      ContentType: 'application/octet-stream',
      ChecksumSHA256: checksum,
      Metadata: sha256 ? { sha256 } : undefined,
    }), { expiresIn: Math.min(Math.max(expiresIn, 30), 300) });
  }

  async function signedGet(objectKey, expiresIn = 60) {
    if (!enabled) throw new Error('Direct media storage is disabled');
    return getSignedUrl(client, new GetObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      ResponseContentType: 'application/octet-stream',
    }), { expiresIn: Math.min(Math.max(expiresIn, 30), 60) });
  }

  async function head(objectKey) {
    if (!enabled) throw new Error('Direct media storage is disabled');
    return client.send(new HeadObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      ChecksumMode: 'ENABLED',
    }));
  }

  async function remove(objectKey) {
    if (!enabled) return;
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey }));
  }

  return { configured, enabled, head, remove, signedGet, signedPut };
}

module.exports = { createMediaStore, readBucketConfig };
