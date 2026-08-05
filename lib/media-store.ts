import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Local-filesystem media store (panel side). Mirror of worker/src/media-store.ts
 * — both processes run on the same VPS and share MEDIA_STORE_DIR, so either
 * can read files the other archived (paths in media_blobs.file_path are
 * absolute). No third-party storage involved: bytes live on this host's disk.
 *
 * Layout: MEDIA_STORE_DIR/<first 2 chars of uuid>/<uuid> — two-level sharding
 * keeps directories small even with hundreds of thousands of files.
 */

const MEDIA_STORE_DIR = path.resolve(
  process.env.MEDIA_STORE_DIR || path.join(process.cwd(), 'media-store'),
)

/**
 * Write a media buffer to the local store. Returns the ABSOLUTE path for
 * media_blobs.file_path. Throws on failure — callers fall back to bytea so
 * the archive guarantee survives a full/broken disk.
 */
export async function saveMediaFile(bytes: Buffer): Promise<string> {
  const id = randomUUID()
  const dir = path.join(MEDIA_STORE_DIR, id.slice(0, 2))
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, id)
  // Temp name + rename: a crash mid-write can never leave a half-written file
  // at a path the DB points to (rename is atomic on POSIX).
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, bytes)
  await fs.rename(tmp, filePath)
  return filePath
}

/** Read a stored media file. Returns null when the file is gone/unreadable. */
export async function readMediaFile(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath)
  } catch {
    return null
  }
}

/** Best-effort delete (used to roll back after a failed DB insert). */
export async function deleteMediaFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch {
    /* already gone — fine */
  }
}
