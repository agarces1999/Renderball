import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

/**
 * Cloudflare R2 (S3-compatible) object storage.
 *
 * Holds the durable, redeploy-proof artifacts that can't live on an ephemeral
 * container disk: finished MP4 renders and user uploads. The bucket is PRIVATE
 * — objects are reached either by streaming through an owner-gated route
 * (renders) or via a short-lived signed URL minted server-side (assets the
 * renderer/browser load directly). Configured via the STORAGE_* env vars; when
 * they're unset (e.g. a quick local run) callers fall back to local disk.
 */
const endpoint = process.env.STORAGE_ENDPOINT;
const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID;
const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY;
const bucket = process.env.STORAGE_BUCKET;

export const isStorageConfigured = (): boolean =>
  Boolean(endpoint && accessKeyId && secretAccessKey && bucket);

let _client: S3Client | null = null;
const client = (): S3Client => {
  if (!isStorageConfigured()) {
    throw new Error("R2 storage is not configured (missing STORAGE_* env).");
  }
  if (!_client) {
    _client = new S3Client({
      region: process.env.STORAGE_REGION || "auto",
      endpoint,
      credentials: {
        accessKeyId: accessKeyId as string,
        secretAccessKey: secretAccessKey as string,
      },
    });
  }
  return _client;
};

/** Upload bytes to `key`. Returns the key. */
export const putObject = async (
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<string> => {
  await client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return key;
};

/** Read an object's bytes, or null if it isn't there. */
export const getObjectBytes = async (key: string): Promise<Buffer | null> => {
  try {
    const res = await client().send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!res.Body) return null;
    const bytes = await res.Body.transformToByteArray();
    return Buffer.from(bytes);
  } catch {
    return null;
  }
};

/**
 * A time-limited GET URL for `key`. Used to hand the renderer (headless
 * Chromium) and the browser a direct, no-auth-needed link to a private object
 * without ever making the bucket public. Default TTL 1h — long enough for a
 * render or a preview session.
 */
export const getSignedDownloadUrl = async (
  key: string,
  expiresInSeconds = 3600,
): Promise<string> => {
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  return getSignedUrl(
    client(),
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: expiresInSeconds },
  );
};

/** Canonical key layout. */
export const renderKey = (scriptId: string): string =>
  `renders/${scriptId}.mp4`;
export const uploadKey = (briefId: string, filename: string): string =>
  `uploads/${briefId}/${filename}`;
