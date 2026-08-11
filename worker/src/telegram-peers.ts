import { Api, type TelegramClient } from 'telegram'
import { returnBigInt } from 'telegram/Helpers.js'
import { logger } from './logger.js'
import * as repo from './repo.js'
import { errMessage } from './telegram-errors.js'
import {
  inputPeerFromRecord,
  peerRecordFromEntity,
} from './telegram-config.js'

/**
 * Peer (contact_handle → InputPeer) resolution, extracted from the
 * TelegramSession monolith.
 *
 * For a numeric peer id MTProto requires the peer's access_hash, which lives
 * in the session's local entity cache. After a worker restart that cache can
 * be incomplete (the saved string session doesn't carry every entity), so a
 * plain getInputEntity throws "Could not find the input entity for ...". When
 * that happens we refresh the dialog list (which repopulates the cache with
 * access_hashes) and retry, then fall back to getEntity as a last resort.
 *
 * `createTargetResolver` owns the "one getDialogs sweep per minute" rate limit
 * as closure state — previously the `dialogsRefreshedAt` private field.
 */
export function createTargetResolver(deps: {
  channelId: string
  getClient: () => TelegramClient | null
  syncDialogs: () => Promise<void>
}): (target: string) => Promise<Api.TypeInputPeer | string> {
  /** Tracks whether we've already refreshed the entity cache this session, so a
   * cache miss only triggers ONE expensive getDialogs sweep, not one per send. */
  let dialogsRefreshedAt = 0

  return async function resolveTarget(
    target: string,
  ): Promise<Api.TypeInputPeer | string> {
    if (target.startsWith('@')) return target
    const client = deps.getClient()
    if (!client) throw new Error('Session not started')
    const peerId = returnBigInt(target)

    // 1) Durable peer cache: rebuild the input peer from a persisted
    // access_hash. This survives restarts and is independent of GramJS's
    // in-memory entity cache (the thing that throws "input entity not found").
    try {
      const stored = await repo.getTelegramPeer(deps.channelId, target)
      if (stored) {
        const peer = inputPeerFromRecord(stored)
        if (peer) return peer
      }
    } catch (err) {
      logger.warn(
        { channelId: deps.channelId, target, err: errMessage(err) },
        'Telegram peer cache lookup failed',
      )
    }

    // 2) In-memory entity cache.
    try {
      return await client.getInputEntity(peerId)
    } catch (err) {
      logger.warn(
        { channelId: deps.channelId, target, err: errMessage(err) },
        'Telegram entity cache miss; refreshing dialogs to resolve peer',
      )
      // 3) Repopulate the entity cache (access_hashes) from the dialog list.
      // Rate-limited to once per 60s so a burst of sends to unknown peers
      // can't spam getDialogs. The sync also persists peers durably.
      if (Date.now() - dialogsRefreshedAt > 60_000) {
        dialogsRefreshedAt = Date.now()
        try {
          await deps.syncDialogs()
        } catch (e) {
          logger.warn(
            { channelId: deps.channelId, err: errMessage(e) },
            'Telegram dialog refresh during resolve failed',
          )
        }
      }
      try {
        return await client.getInputEntity(peerId)
      } catch {
        // 4) Last resort: resolve the full entity (also caches it), persist
        // its access_hash for next time, and derive the input peer from it.
        const entity = (await client.getEntity(peerId)) as
          | Api.User
          | Api.Chat
          | Api.Channel
        const rec = peerRecordFromEntity(entity)
        if (rec) {
          await repo
            .saveTelegramPeer(deps.channelId, target, rec)
            .catch(() => {})
        }
        return client.getInputEntity(entity)
      }
    }
  }
}
