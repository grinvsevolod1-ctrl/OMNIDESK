import type { TelegramClient, Api } from 'telegram'
import type { Dialog } from 'telegram/tl/custom/dialog.js'
import { logger } from './logger.js'
import * as repo from './repo.js'
import { classifyTgMedia } from './telegram-media.js'
import { errMessage } from './telegram-errors.js'
import {
  TG_BACKFILL_BATCH,
  TG_BACKFILL_MAX_CHATS,
  TG_BACKFILL_MEDIA_THROTTLE_MS,
  TG_BACKFILL_PAGE_THROTTLE_MS,
  TG_BACKFILL_PER_CHAT,
  TG_BACKFILL_THROTTLE_MS,
  TG_DIALOG_FOLDERS,
  TG_DIALOG_LIMIT,
  TG_DIALOG_LIMIT_ALL,
  TG_STORE_MEDIA_BACKFILL,
  peerRecordFromEntity,
} from './telegram-config.js'
import type { TgSessionCtx } from './telegram-session-ctx.js'

/**
 * Dialog import + full-history backfill for one Telegram session. Extracted
 * verbatim from the TelegramSession monolith; operates on the narrow
 * TgSessionCtx so it can re-check the live client / pause flag at every
 * checkpoint exactly like the original private methods did.
 */

/**
 * Pull existing Telegram chats (private DMs only — groups and channels are
 * skipped as noise) into the inbox so the
 * manager sees their real conversation list, not just messages that arrive
 * after connecting. Idempotent: re-running just refreshes previews/unread.
 */
export async function syncDialogs(
  ctx: TgSessionCtx,
  opts?: { backfill?: boolean },
): Promise<void> {
  const client = ctx.getClient()
  if (!client) return
  // Don't backfill history into the inbox while paused.
  if (ctx.isIngestPaused()) return

  // Enumeration cap: 0 (default) means "every chat", expressed to GramJS as a
  // very large finite limit so the enumerator pages to the true end of the
  // list instead of hitting the old 500-chat ceiling.
  const enumLimit = TG_DIALOG_LIMIT > 0 ? TG_DIALOG_LIMIT : TG_DIALOG_LIMIT_ALL

  let imported = 0
  // How many chats we've backfilled message history for this sweep, shared
  // across BOTH folders and bounded by TG_BACKFILL_MAX_CHATS (0 = no cap).
  let backfilled = 0
  // Peers already handled this sweep, so a dialog that somehow appears in both
  // the main and archived passes is never imported or backfilled twice.
  const seenPeers = new Set<string>()

  // Sweep BOTH folders (0 = main inbox, 1 = Archived) so archived
  // conversations are pulled in exactly like active ones.
  for (const folder of TG_DIALOG_FOLDERS) {
    if (!ctx.getClient() || ctx.isIngestPaused()) break
    try {
      // iterDialogs streams one page at a time instead of materializing the
      // whole dialog list (previously getDialogs with a de-facto unbounded
      // limit built an array of EVERY chat + entity in memory at once —
      // significant for accounts with thousands of dialogs).
      for await (const dialog of client.iterDialogs({
        limit: enumLimit,
        folder,
      })) {
        if (!ctx.getClient() || ctx.isIngestPaused()) break
        try {
          const handled = await importDialog(ctx, dialog, {
            backfill: Boolean(opts?.backfill),
            seenPeers,
            canBackfill:
              TG_BACKFILL_MAX_CHATS === 0 || backfilled < TG_BACKFILL_MAX_CHATS,
          })
          if (handled === 'skipped') continue
          imported++
          if (handled === 'backfilled') {
            backfilled++
            // Throttle between chats to stay well under Telegram flood limits.
            await new Promise((r) => setTimeout(r, TG_BACKFILL_THROTTLE_MS))
          }
        } catch (err) {
          logger.warn({ err }, 'telegram dialog import skipped')
        }
      }
    } catch (err) {
      logger.error({ err, folder }, 'telegram dialog sync failed for folder')
    }
  }

  logger.info(
    { channelId: ctx.channelId, imported, backfilled },
    'Telegram dialogs synced (all folders)',
  )
}

/**
 * Import one dialog into the inbox and (optionally) backfill its full history.
 * Returns what happened so the caller can keep accurate counters and pace the
 * flood-safe throttle only when a backfill actually ran.
 */
async function importDialog(
  ctx: TgSessionCtx,
  dialog: Dialog,
  ictx: { backfill: boolean; canBackfill: boolean; seenPeers: Set<string> },
): Promise<'skipped' | 'imported' | 'backfilled'> {
  // Только личные чаты (users): группы, супергруппы, беседы и каналы в инбокс
  // не импортируются вообще — это мусор для продавца (то же правило, что и в
  // live-обработчике telegram-updates.ts).
  const entity = dialog.entity as Api.User | Api.Chat | Api.Channel | undefined
  if (!entity) return 'skipped'
  const isUser = entity.className === 'User'
  if (!isUser) return 'skipped'
  if (isUser && 'bot' in entity && entity.bot) {
    // keep bots out unless they messaged — most are noise
    if (!dialog.message?.message) return 'skipped'
  }

  const { name, handle } = dialogIdentity(dialog, entity, isUser)

  // De-dupe across folder passes: a peer handled once is never redone.
  const peerKey = String((entity as { id?: unknown }).id ?? handle)
  if (ictx.seenPeers.has(peerKey)) return 'skipped'
  ictx.seenPeers.add(peerKey)

  // Public @username for a direct (user) chat, when present. Groups have
  // no single contact username, so leave it null for them.
  const contactUsername =
    isUser && 'username' in entity ? (entity.username ?? null) : null
  // Cache the peer's access_hash for durable addressing after restarts.
  const peerRecord = peerRecordFromEntity(entity)
  if (peerRecord) {
    await repo
      .saveTelegramPeer(ctx.channelId, handle, peerRecord)
      .catch(() => {})
  }
  const lastMessage =
    dialog.message?.message ||
    (dialog.message ? '[non-text message]' : '[no messages yet]')
  const lastDate = dialog.message?.date
    ? new Date(dialog.message.date * 1000)
    : new Date()
  const fromMe = Boolean(dialog.message?.out)

  await repo.upsertDialog({
    channelId: ctx.channelId,
    managerId: ctx.managerId,
    channelType: 'telegram',
    contactName: name,
    contactHandle: handle,
    contactUsername,
    lastMessage,
    lastMessageAt: lastDate,
    unread: dialog.unreadCount ?? 0,
    lastFromMe: fromMe,
  })

  // Backfill the COMPLETE message history so opened threads show the full
  // conversation. TG_BACKFILL_MAX_CHATS === 0 means "no cap" (every chat).
  if (ictx.backfill && dialog.message && ictx.canBackfill) {
    await backfillDialogHistory(ctx, entity, handle, isUser, name)
    return 'backfilled'
  }
  return 'imported'
}

/**
 * Pull the message history of a single chat into the inbox, tracked by a
 * per-chat WATERMARK (scripts/105) so work is never repeated:
 *
 *   Phase A (gap top-up): if the chat has been synced before, fetch only
 *   messages NEWER than newest_synced_id — the offline gap. On a typical
 *   reconnect this is a single small page instead of the entire history.
 *
 *   Phase B (deep backfill): pages backwards toward the first message, but
 *   only until `complete` — and RESUMES from oldest_synced_id if a previous
 *   sweep was interrupted, instead of restarting from the top.
 *
 * Idempotent: ingestInbound de-duplicates on providerMessageId, and
 * countUnread:false means backfilling old chats doesn't light up unread
 * badges. Uses only cached sender data (no per-message network calls) and
 * sleeps between pages to keep the full sweep flood-safe.
 */
async function backfillDialogHistory(
  ctx: TgSessionCtx,
  entity: Api.User | Api.Chat | Api.Channel,
  handle: string,
  isUser: boolean,
  contactName: string,
): Promise<void> {
  const client = ctx.getClient()
  if (!client) return

  // Watermark read is best-effort: if the table is missing (migration not yet
  // applied) fall back to the old full-backfill behaviour instead of failing.
  const wm = await repo
    .getBackfillWatermark(ctx.channelId, handle)
    .catch(() => null)

  let fetched = 0

  /**
   * Ingest one getMessages page (oldest-first within the page so the stored
   * thread keeps natural chronological order). Returns the page's id range.
   */
  async function ingestPage(
    messages: Awaited<ReturnType<TelegramClient['getMessages']>>,
  ): Promise<{ maxId: number; minId: number }> {
    let maxId = 0
    let minId = Number.MAX_SAFE_INTEGER
    for (const msg of [...messages].reverse()) {
      if (!msg) continue
      if (msg.id > maxId) maxId = msg.id
      if (msg.id < minId) minId = msg.id
      const media = classifyTgMedia(msg)
      const text = msg.message || (media ? media.placeholder : '')
      if (!text && !media) continue // skip service/empty messages
      const out = Boolean(msg.out)

      // For groups, prefix the sender name using cached data only
      // (msg.sender is populated by getMessages) — never await getSender().
      let body = text
      if (!isUser && !out) {
        const s = msg.sender as Api.User | null
        const senderName =
          s && 'firstName' in s
            ? [s.firstName, s.lastName].filter(Boolean).join(' ') ||
              (s.username ? `@${s.username}` : 'Участник')
            : 'Участник'
        body = `${senderName}: ${text}`
      }

      const histIngest = await repo.ingestInbound({
        channelId: ctx.channelId,
        managerId: ctx.managerId,
        channelType: 'telegram',
        contactName,
        contactHandle: handle,
        body,
        direction: out ? 'out' : 'in',
        author: out ? 'Вы' : undefined,
        providerMessageId: String(msg.id),
        createdAt: msg.date ? new Date(msg.date * 1000) : undefined,
        countUnread: false,
        ...(media
          ? {
              mediaType: media.mediaType,
              mediaMime: media.mediaMime,
              mediaName: media.mediaName,
              mediaRef: { peer: handle, msgId: String(msg.id) },
            }
          : {}),
      })

      // Persist historical media bytes too (throttled to stay flood-safe).
      if (media && TG_STORE_MEDIA_BACKFILL && histIngest.messageId) {
        await ctx.persistMediaBytes(histIngest.messageId, msg)
        if (TG_BACKFILL_MEDIA_THROTTLE_MS > 0) {
          await new Promise((r) =>
            setTimeout(r, TG_BACKFILL_MEDIA_THROTTLE_MS),
          )
        }
      }
    }
    return { maxId, minId: minId === Number.MAX_SAFE_INTEGER ? 0 : minId }
  }

  try {
    // ---- Phase A: gap top-up (only messages newer than the watermark). ----
    if (wm && wm.newestSyncedId > 0) {
      let offsetId = 0
      for (;;) {
        if (!ctx.getClient() || ctx.isIngestPaused()) return
        const messages = await client.getMessages(entity, {
          limit: TG_BACKFILL_BATCH,
          minId: wm.newestSyncedId,
          ...(offsetId ? { offsetId } : {}),
        })
        if (!messages || messages.length === 0) break
        const { maxId, minId } = await ingestPage(messages)
        fetched += messages.length
        if (maxId > 0) {
          await repo
            .upsertBackfillWatermark(ctx.channelId, handle, {
              newestSyncedId: maxId,
            })
            .catch(() => {})
        }
        if (messages.length < TG_BACKFILL_BATCH || minId <= 0) break
        offsetId = minId
        await new Promise((r) => setTimeout(r, TG_BACKFILL_PAGE_THROTTLE_MS))
      }
    }

    // ---- Phase B: deep backfill toward the first message (once). ----
    if (wm?.complete) return
    // Resume where the previous (interrupted) sweep stopped; 0 = from the top.
    let offsetId = wm?.oldestSyncedId ?? 0
    for (;;) {
      if (!ctx.getClient() || ctx.isIngestPaused()) return
      // When a per-chat cap is set, never request more than what's left.
      const remaining =
        TG_BACKFILL_PER_CHAT > 0 ? TG_BACKFILL_PER_CHAT - fetched : Infinity
      if (remaining <= 0) {
        // Cap reached counts as done — otherwise every sweep would re-walk
        // the capped window forever without ever finishing.
        await repo
          .upsertBackfillWatermark(ctx.channelId, handle, { complete: true })
          .catch(() => {})
        break
      }
      const pageSize = Math.min(TG_BACKFILL_BATCH, remaining)
      const messages = await client.getMessages(entity, {
        limit: pageSize,
        ...(offsetId ? { offsetId } : {}),
      })
      if (!messages || messages.length === 0) {
        await repo
          .upsertBackfillWatermark(ctx.channelId, handle, { complete: true })
          .catch(() => {})
        break
      }

      const { maxId, minId } = await ingestPage(messages)
      fetched += messages.length
      // Persist progress after EVERY page so an interruption resumes here.
      await repo
        .upsertBackfillWatermark(ctx.channelId, handle, {
          ...(maxId > 0 ? { newestSyncedId: maxId } : {}),
          ...(minId > 0 ? { oldestSyncedId: minId } : {}),
        })
        .catch(() => {})

      // A short page means we've reached the first message.
      if (messages.length < pageSize || minId <= 0) {
        await repo
          .upsertBackfillWatermark(ctx.channelId, handle, { complete: true })
          .catch(() => {})
        break
      }
      offsetId = minId

      // Pace between pages so a long history can't trip the flood limiter.
      await new Promise((r) => setTimeout(r, TG_BACKFILL_PAGE_THROTTLE_MS))
    }
  } catch (err) {
    // Log what we managed to import so a mid-sweep flood-wait is visible; the
    // next reconnect RESUMES from the persisted watermark (no re-walk, and
    // ingest is idempotent, so no dupes either).
    logger.warn(
      { channelId: ctx.channelId, handle, fetched, err: errMessage(err) },
      'telegram history backfill interrupted',
    )
  }
}

/** Stable display name + handle for a dialog entry. */
export function dialogIdentity(
  dialog: Dialog,
  entity: Api.User | Api.Chat | Api.Channel,
  isUser: boolean,
): { name: string; handle: string } {
  // Stable handle: the marked peer id (string) so it matches live messages
  // keyed on msg.chatId and can be resolved back for sending.
  const handle = dialog.id ? String(dialog.id) : String(entity.id)
  let name: string
  if (isUser && 'firstName' in entity) {
    name =
      [entity.firstName, entity.lastName].filter(Boolean).join(' ') ||
      (entity.username ? `@${entity.username}` : 'Telegram user')
  } else if ('title' in entity && entity.title) {
    name = entity.title
  } else {
    name = dialog.title || 'Telegram chat'
  }
  return { name, handle }
}
