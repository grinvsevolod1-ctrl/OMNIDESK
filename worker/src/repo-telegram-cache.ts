import { query, one } from './db.js'

/* ----------------------- Telegram peer cache ------------------------- */

export type TelegramPeerKind = 'user' | 'channel' | 'chat'

export interface TelegramPeerRecord {
  kind: TelegramPeerKind
  peerId: string
  accessHash: string | null
}

/**
 * Persist a Telegram peer's access_hash so we can reconstruct an input peer
 * after a restart without relying on GramJS's volatile entity cache. Upserts on
 * (channel_id, handle); a null access_hash (basic groups) is allowed.
 */
export async function saveTelegramPeer(
  channelId: string,
  handle: string,
  peer: TelegramPeerRecord,
): Promise<void> {
  await query(
    `INSERT INTO telegram_peers (channel_id, handle, kind, peer_id, access_hash, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (channel_id, handle) DO UPDATE
       SET kind = EXCLUDED.kind,
           peer_id = EXCLUDED.peer_id,
           access_hash = COALESCE(EXCLUDED.access_hash, telegram_peers.access_hash),
           updated_at = now()`,
    [channelId, handle, peer.kind, peer.peerId, peer.accessHash],
  )
}

/** Look up a persisted Telegram peer by its stored handle. */
export async function getTelegramPeer(
  channelId: string,
  handle: string,
): Promise<TelegramPeerRecord | null> {
  const row = await one<{
    kind: TelegramPeerKind
    peer_id: string
    access_hash: string | null
  }>(
    `SELECT kind, peer_id, access_hash FROM telegram_peers
      WHERE channel_id = $1 AND handle = $2`,
    [channelId, handle],
  )
  if (!row) return null
  return { kind: row.kind, peerId: row.peer_id, accessHash: row.access_hash }
}

/* ---------------------- Backfill watermarks ---------------------- */

/**
 * Per-chat history sync progress (see scripts/105). Lets a reconnect fetch
 * only the offline gap instead of re-paging the chat's entire history, and
 * lets an interrupted deep backfill resume where it stopped.
 */
export interface BackfillWatermark {
  newestSyncedId: number
  oldestSyncedId: number
  complete: boolean
}

export async function getBackfillWatermark(
  channelId: string,
  handle: string,
): Promise<BackfillWatermark | null> {
  const row = await one<{
    newest_synced_id: string
    oldest_synced_id: string
    complete: boolean
  }>(
    `SELECT newest_synced_id, oldest_synced_id, complete
       FROM telegram_backfill_watermarks
      WHERE channel_id = $1 AND contact_handle = $2`,
    [channelId, handle],
  )
  if (!row) return null
  return {
    newestSyncedId: Number(row.newest_synced_id),
    oldestSyncedId: Number(row.oldest_synced_id),
    complete: row.complete,
  }
}

/**
 * Monotonic upsert: newest only ever grows, oldest only ever shrinks (toward
 * the first message), complete never reverts to false. Safe to call from
 * overlapping sweeps.
 */
export async function upsertBackfillWatermark(
  channelId: string,
  handle: string,
  patch: Partial<BackfillWatermark>,
): Promise<void> {
  await query(
    `INSERT INTO telegram_backfill_watermarks
       (channel_id, contact_handle, newest_synced_id, oldest_synced_id, complete, updated_at)
     VALUES ($1, $2, COALESCE($3, 0), COALESCE($4, 0), COALESCE($5, false), now())
     ON CONFLICT (channel_id, contact_handle) DO UPDATE
       SET newest_synced_id = GREATEST(
             telegram_backfill_watermarks.newest_synced_id,
             COALESCE($3, telegram_backfill_watermarks.newest_synced_id)
           ),
           oldest_synced_id = CASE
             WHEN $4 IS NULL THEN telegram_backfill_watermarks.oldest_synced_id
             WHEN telegram_backfill_watermarks.oldest_synced_id = 0 THEN $4
             ELSE LEAST(telegram_backfill_watermarks.oldest_synced_id, $4)
           END,
           complete = telegram_backfill_watermarks.complete OR COALESCE($5, false),
           updated_at = now()`,
    [
      channelId,
      handle,
      patch.newestSyncedId ?? null,
      patch.oldestSyncedId ?? null,
      patch.complete ?? null,
    ],
  )
}
