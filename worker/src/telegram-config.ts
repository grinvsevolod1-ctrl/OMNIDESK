import { Api } from 'telegram'
import { returnBigInt } from 'telegram/Helpers.js'
import * as repo from './repo.js'

// Tunables and pure peer <-> record helpers for the Telegram session, split out
// of the TelegramSession monolith. Everything here is stateless (no `this`), so
// the session file re-imports these symbols instead of defining them inline.

// Per-account outgoing throttle. Telegram aggressively rate-limits (and can ban)
// userbots that send at machine speed; a minimum spacing plus human jitter keeps
// each account's send rate within safe, human-like bounds.
export const TG_SEND_MIN_INTERVAL_MS = 1_200
export const TG_SEND_JITTER_MS = 800

/** Parse a non-negative integer env var, falling back to `def` when unset/invalid. */
export function envInt(name: string, def: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return def
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : def
}

// History backfill. On connect (and reconnect) we pull the COMPLETE message
// history of EVERY chat into the inbox — every message and every file, all the
// way back to the very first message — so an opened conversation shows the full
// thread, not just what arrived live after connecting.
//
// "Every chat" is meant literally: we enumerate BOTH the main folder (0) and the
// Archived folder (1), with NO cap on how many chats are listed (the enumerator
// pages internally until Telegram reports the end of the list). Telegram's
// client-side "chat folders" are just saved views over these two folders, so
// folder 0 + folder 1 together cover 100% of dialogs.
//
// A full history sweep is exactly what trips Telegram's flood limits and gets
// userbots banned, so the whole sweep is deliberately paced: we page messages in
// chunks of TG_BACKFILL_BATCH and sleep between every page AND between every
// chat. Defaults are conservative; all knobs are env-overridable so an operator
// can trade speed for safety (or vice-versa) per deployment:
//
//   TG_DIALOG_LIMIT             cap chats to ENUMERATE (0 = all, the default)
//   TG_BACKFILL_MAX_CHATS       cap chats to backfill history for (0 = all)
//   TG_BACKFILL_PER_CHAT        cap messages per chat (0 = to the first message)
//   TG_BACKFILL_CHAT_THROTTLE_MS  pause between chats
//   TG_BACKFILL_PAGE_THROTTLE_MS  pause between message pages within a chat
export const TG_DIALOG_LIMIT = envInt('TG_DIALOG_LIMIT', 0)
export const TG_BACKFILL_MAX_CHATS = envInt('TG_BACKFILL_MAX_CHATS', 0)
export const TG_BACKFILL_PER_CHAT = envInt('TG_BACKFILL_PER_CHAT', 0)
// Telegram caps getMessages at 100 per request; pull full pages to minimise
// the number of round-trips (fewer requests = lower flood risk per message).
export const TG_BACKFILL_BATCH = 100
// Telegram's dialog folders: 0 = main inbox, 1 = Archived. We sweep both so no
// archived conversation is ever missed.
export const TG_DIALOG_FOLDERS = [0, 1] as const
// GramJS treats limit<=0 as "count only", so "all" is expressed as a very large
// finite limit; the enumerator still stops as soon as the real list ends.
export const TG_DIALOG_LIMIT_ALL = 1_000_000
export const TG_BACKFILL_THROTTLE_MS = envInt('TG_BACKFILL_CHAT_THROTTLE_MS', 900)
export const TG_BACKFILL_PAGE_THROTTLE_MS = envInt(
  'TG_BACKFILL_PAGE_THROTTLE_MS',
  700,
)
// Persist media bytes into Postgres at ingest so files survive the contact
// deleting/editing the original. Toggle off (TG_STORE_MEDIA=0) to fall back to
// on-demand re-download only. Files larger than the cap are left on-demand so a
// stray 2GB video can't bloat the database.
export const TG_STORE_MEDIA = (process.env.TG_STORE_MEDIA ?? '1') !== '0'
export const TG_STORE_MEDIA_BACKFILL =
  (process.env.TG_STORE_MEDIA_BACKFILL ?? '1') !== '0'
export const MEDIA_MAX_STORE_BYTES = envInt(
  'MEDIA_MAX_STORE_BYTES',
  50 * 1024 * 1024,
)
// Small pause after each stored file during history backfill so a media-heavy
// chat can't burst downloads and trip the flood limiter.
export const TG_BACKFILL_MEDIA_THROTTLE_MS = envInt(
  'TG_BACKFILL_MEDIA_THROTTLE_MS',
  250,
)

// Session health ping: a lightweight RPC on a fixed cadence so a zombie
// connection (TCP alive, MTProto dead — typical after a proxy hiccup) is
// detected within ~2 ticks instead of on the next failed send. Ping traffic
// is what every official client does continuously; this adds no flood risk.
export const TG_HEALTH_PING_MS = envInt('TG_HEALTH_PING_MS', 90_000)
// How long one ping may take before it counts as failed (dead connections
// often HANG rather than error).
export const TG_HEALTH_PING_TIMEOUT_MS = envInt('TG_HEALTH_PING_TIMEOUT_MS', 15_000)

/**
 * Extract a persistable peer record (kind + id + access_hash) from a GramJS
 * entity. Returns null for entities we can't address (e.g. deleted accounts).
 */
export function peerRecordFromEntity(
  entity: Api.User | Api.Chat | Api.Channel | null | undefined,
): repo.TelegramPeerRecord | null {
  if (!entity) return null
  if (entity.className === 'User') {
    return {
      kind: 'user',
      peerId: String(entity.id),
      accessHash: entity.accessHash ? String(entity.accessHash) : null,
    }
  }
  if (entity.className === 'Channel') {
    return {
      kind: 'channel',
      peerId: String(entity.id),
      accessHash: entity.accessHash ? String(entity.accessHash) : null,
    }
  }
  if (entity.className === 'Chat') {
    return { kind: 'chat', peerId: String(entity.id), accessHash: null }
  }
  return null
}

/** Rebuild a GramJS input peer from a persisted peer record. */
export function inputPeerFromRecord(
  rec: repo.TelegramPeerRecord,
): Api.TypeInputPeer | null {
  if (rec.kind === 'user' && rec.accessHash) {
    return new Api.InputPeerUser({
      userId: returnBigInt(rec.peerId),
      accessHash: returnBigInt(rec.accessHash),
    })
  }
  if (rec.kind === 'channel' && rec.accessHash) {
    return new Api.InputPeerChannel({
      channelId: returnBigInt(rec.peerId),
      accessHash: returnBigInt(rec.accessHash),
    })
  }
  if (rec.kind === 'chat') {
    return new Api.InputPeerChat({ chatId: returnBigInt(rec.peerId) })
  }
  return null
}
