import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  deleteMediaObject,
  isMediaS3Configured,
  isS3Locator,
  readMediaObject,
  saveMediaObject,
} from './media-s3'

/**
 * Tiered media store (worker side). Mirror of lib/media-store.ts — both
 * processes share the same env, so either can read what the other archived.
 *
 * Storage ladder (best scaling first, most local last):
 *   1. S3-compatible object storage — when MEDIA_S3_* is configured. The only
 *      tier that scales horizontally; locator form `s3://bucket/key`.
 *   2. Local VPS filesystem — MEDIA_STORE_DIR/<2-char shard>/<uuid>, absolute
 *      POSIX path as the locator. Two-level sharding keeps directories small.
 *   3. Postgres bytea — the caller's fallback when saveMediaFile throws.
 *
 * readMediaFile dispatches on the locator prefix, so rows written by any tier
 * in any era keep working forever — no migration required to enable S3.
 */

const MEDIA_STORE_DIR = path.resolve(
  process.env.MEDIA_STORE_DIR || path.join(process.cwd(), 'media-store'),
)

/**
 * Write a media buffer to the store. Returns the locator persisted in
 * media_blobs.file_path (`s3://…` or an absolute path). Prefers S3; on S3
 * failure falls back to local disk. Throws only when EVERY tier failed —
 * callers then fall back to bytea so the archive guarantee survives.
 */
export async function saveMediaFile(
  bytes: Buffer,
  mime: string | null = null,
): Promise<string> {
  if (isMediaS3Configured()) {
    try {
      return await saveMediaObject(bytes, mime)
    } catch (err) {
      console.error('media-store: S3 write failed, falling back to disk:', err)
    }
  }
  const id = randomUUID()
  const dir = path.join(MEDIA_STORE_DIR, id.slice(0, 2))
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, id)
  // Write via temp name + rename so a crash mid-write can never leave a
  // half-written file at a path the DB points to (rename is atomic on POSIX).
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, bytes)
  await fs.rename(tmp, filePath)
  return filePath
}

/** Read stored media by locator. Returns null when gone/unreadable. */
export async function readMediaFile(filePath: string): Promise<Buffer | null> {
  if (isS3Locator(filePath)) return readMediaObject(filePath)
  try {
    return await fs.readFile(filePath)
  } catch {
    return null
  }
}

/** Best-effort delete (used to roll back after a failed DB insert). */
export async function deleteMediaFile(filePath: string): Promise<void> {
  if (isS3Locator(filePath)) return deleteMediaObject(filePath)
  try {
    await fs.unlink(filePath)
  } catch {
    /* already gone — fine */
  }
}
