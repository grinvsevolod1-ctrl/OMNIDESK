import { Api, TelegramClient } from 'teleproto'
import { logger } from './logger.js'
import * as repo from './repo.js'
import { persistMediaBytes } from './telegram-media-io.js'

/** What the media-backfill sweep needs from the owning session. */
export interface TelegramMediaBackfillDeps {
  channelId: string
  getClient: () => TelegramClient | null
  resolveTarget: (target: string) => Promise<Api.TypeInputPeer | string>
}

/**
 * Post-reconnect media backfill. Incoming Telegram media is normally archived
 * to media_blobs at ingest, but any message that arrived while archiving was
 * off/failed (or under an older worker build) has media_type set and
 * media_blob_id NULL. Those force a LIVE re-download from Telegram on every
 * view, and when the file reference is stale or the session is slow the view
 * times out and shows "Медиа недоступно" — for BOTH the manager and curator
 * inboxes, since both serve bytes through /api/media.
 *
 * This sweep re-downloads and archives the missing bytes so the media then
 * serves instantly from our own copy, regardless of where it came from. It is
 * flood-safe: small batch, sequential, paced, and fully best-effort —
 * persistMediaBytes is itself idempotent (skips rows that already have bytes).
 */
export async function backfillMissingMedia(
  deps: TelegramMediaBackfillDeps,
): Promise<void> {
  try {
    const pending = await repo.listInboundMediaNeedingBytes(deps.channelId)
    if (pending.length === 0) return
    logger.info(
      { channelId: deps.channelId, count: pending.length },
      'TG media backfill: archiving un-stored incoming media',
    )

    // Cache resolved peers so many messages from the same contact cost one
    // entity resolution, not one per message.
    const entityByPeer = new Map<string, Api.TypeInputPeer | string>()
    const resolvePeer = async (
      peer: string,
    ): Promise<Api.TypeInputPeer | string | null> => {
      const cached = entityByPeer.get(peer)
      if (cached) return cached
      try {
        const entity = await deps.resolveTarget(peer)
        entityByPeer.set(peer, entity)
        return entity
      } catch {
        return null
      }
    }

    for (const row of pending) {
      const client = deps.getClient()
      if (!client) return // disconnected mid-sweep — next login retries
      try {
        const entity = await resolvePeer(row.peer)
        if (!entity) continue
        const messages = await client.getMessages(entity, {
          ids: [Number(row.msgId)],
        })
        const message = messages?.[0]
        if (!message || !message.media) continue
        await persistMediaBytes(client, row.id, message as Api.Message)
        // Gentle pacing: media downloads are heavier than text RPCs, so space
        // them out to stay well clear of FLOOD_WAIT during the sweep.
        await new Promise((r) => setTimeout(r, 400))
      } catch (err) {
        logger.warn(
          { channelId: deps.channelId, messageId: row.id, err },
          'TG media backfill: one message failed (non-fatal)',
        )
      }
    }
  } catch (err) {
    logger.warn(
      { channelId: deps.channelId, err },
      'TG media backfill sweep failed (non-fatal)',
    )
  }
}
