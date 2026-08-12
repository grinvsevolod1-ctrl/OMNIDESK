import { randomUUID } from 'node:crypto'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'

/**
 * S3-compatible object storage for the media archive (panel side; the worker
 * has a byte-identical mirror in worker/src/media-s3.ts).
 *
 * Purpose: at "millions of users" scale neither Postgres bytea nor the local
 * VPS disk can hold the media archive — object storage is the only tier that
 * scales horizontally and survives host loss. Works with any S3-compatible
 * provider (AWS S3, Cloudflare R2, Backblaze B2, MinIO, Selectel, VK Cloud…).
 *
 * Design: NO schema change. media_blobs.file_path already stores an opaque
 * locator; S3 objects use the `s3://<bucket>/<key>` form while local files
 * keep their absolute POSIX path. readMediaFile dispatches on the prefix, so
 * old rows (disk / bytea) and new rows (S3) coexist forever and a migration
 * can move bytes tier-by-tier at leisure.
 *
 * Failure policy: storage remains BEST-EFFORT and layered — S3 first (when
 * configured), local disk on S3 failure, bytea when the disk also fails. An
 * outage of the object store can therefore never lose an inbound file.
 *
 * Configuration (all required to activate):
 *   MEDIA_S3_ENDPOINT     https endpoint of the provider
 *   MEDIA_S3_BUCKET       bucket name (must exist; private ACL)
 *   MEDIA_S3_ACCESS_KEY   access key id
 *   MEDIA_S3_SECRET_KEY   secret access key
 *   MEDIA_S3_REGION       optional, defaults to "auto"
 *   MEDIA_S3_FORCE_PATH_STYLE optional "1" for MinIO-style path addressing
 */

const S3_PREFIX = 's3://'

const config = {
  endpoint: (process.env.MEDIA_S3_ENDPOINT || '').trim(),
  bucket: (process.env.MEDIA_S3_BUCKET || '').trim(),
  accessKey: (process.env.MEDIA_S3_ACCESS_KEY || '').trim(),
  secretKey: (process.env.MEDIA_S3_SECRET_KEY || '').trim(),
  region: (process.env.MEDIA_S3_REGION || 'auto').trim(),
  forcePathStyle: process.env.MEDIA_S3_FORCE_PATH_STYLE === '1',
}

/** True when every required S3 variable is present. */
export function isMediaS3Configured(): boolean {
  return Boolean(
    config.endpoint && config.bucket && config.accessKey && config.secretKey,
  )
}

/** True when a media_blobs.file_path locator points at object storage. */
export function isS3Locator(filePath: string): boolean {
  return filePath.startsWith(S3_PREFIX)
}

let client: S3Client | null = null
function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    })
  }
  return client
}

/**
 * Upload a media buffer. Returns the `s3://bucket/key` locator persisted in
 * media_blobs.file_path. Keys are sharded like the disk store
 * (media/<2-char shard>/<uuid>) so bucket listings stay navigable. Throws on
 * failure — callers fall down the disk/bytea ladder.
 */
export async function saveMediaObject(
  bytes: Buffer,
  mime: string | null,
): Promise<string> {
  const id = randomUUID()
  const key = `media/${id.slice(0, 2)}/${id}`
  await getClient().send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: bytes,
      ContentType: mime || 'application/octet-stream',
    }),
  )
  return `${S3_PREFIX}${config.bucket}/${key}`
}

/** Read an object by its `s3://bucket/key` locator; null when gone/unreachable. */
export async function readMediaObject(locator: string): Promise<Buffer | null> {
  const rest = locator.slice(S3_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const bucket = rest.slice(0, slash)
  const key = rest.slice(slash + 1)
  try {
    const res = await getClient().send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    )
    if (!res.Body) return null
    const bytes = await res.Body.transformToByteArray()
    return Buffer.from(bytes)
  } catch {
    return null
  }
}

/** Best-effort delete (rollback after a failed DB insert / orphan cleanup). */
export async function deleteMediaObject(locator: string): Promise<void> {
  const rest = locator.slice(S3_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return
  try {
    await getClient().send(
      new DeleteObjectCommand({
        Bucket: rest.slice(0, slash),
        Key: rest.slice(slash + 1),
      }),
    )
  } catch {
    /* already gone or unreachable — orphan cleanup will retry */
  }
}
