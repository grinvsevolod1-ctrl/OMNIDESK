/**
 * Contact-avatar cache (see migration 166). Resolving a Telegram peer to an
 * entity and downloading its profile photo is slow and rate-limited, and the
 * inbox list is virtualized — so we fetch each contact's photo once, store the
 * bytes in `media_blobs`, and remember the mapping here. A negative result
 * (contact has no photo, or the worker was offline) is cached too, so we don't
 * hammer the worker on every scroll.
 */

import { query } from '@/lib/db'

/** How long a cached avatar (or "no photo" marker) stays fresh. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface CachedContactAvatar {
  hasPhoto: boolean
  mediaBlobId: string | null
  fetchedAt: Date
  fresh: boolean
}

/** Look up the cache row for a contact. Returns null when never fetched. */
export async function getCachedContactAvatar(
  channelId: string,
  contactHandle: string,
): Promise<CachedContactAvatar | null> {
  const rows = await query<{
    media_blob_id: string | null
    has_photo: boolean
    fetched_at: string | Date
  }>(
    `SELECT media_blob_id, has_photo, fetched_at
       FROM contact_avatars
      WHERE channel_id = $1 AND contact_handle = $2`,
    [channelId, contactHandle],
  )
  const row = rows[0]
  if (!row) return null
  const fetchedAt = new Date(row.fetched_at)
  return {
    hasPhoto: row.has_photo,
    mediaBlobId: row.media_blob_id,
    fetchedAt,
    fresh: Date.now() - fetchedAt.getTime() < TTL_MS,
  }
}

/** Read the raw bytes of a cached avatar blob. */
export async function getContactAvatarBytes(
  mediaBlobId: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
  const rows = await query<{ bytes: Buffer | null; mime: string | null }>(
    `SELECT bytes, mime FROM media_blobs WHERE id = $1`,
    [mediaBlobId],
  )
  const row = rows[0]
  if (!row || !row.bytes) return null
  return { bytes: row.bytes, mime: row.mime || 'image/jpeg' }
}

/**
 * Persist a freshly fetched avatar: write the bytes into `media_blobs`, then
 * upsert the mapping. Passing `bytes = null` records a negative result (no
 * photo) so we skip the worker until the TTL lapses. Any previous blob for the
 * pair is left to the media offloader; we only repoint the mapping.
 */
export async function storeContactAvatar(
  channelId: string,
  contactHandle: string,
  data: { bytes: Buffer; mime: string } | null,
): Promise<void> {
  let mediaBlobId: string | null = null
  if (data && data.bytes.byteLength > 0) {
    const inserted = await query<{ id: string }>(
      `INSERT INTO media_blobs (bytes, mime, name, byte_size)
         VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [data.bytes, data.mime, 'contact-avatar', data.bytes.byteLength],
    )
    mediaBlobId = inserted[0]?.id ?? null
  }
  await query(
    `INSERT INTO contact_avatars
         (channel_id, contact_handle, media_blob_id, has_photo, fetched_at)
       VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (channel_id, contact_handle) DO UPDATE
       SET media_blob_id = EXCLUDED.media_blob_id,
           has_photo     = EXCLUDED.has_photo,
           fetched_at    = now()`,
    [channelId, contactHandle, mediaBlobId, Boolean(mediaBlobId)],
  )
}
