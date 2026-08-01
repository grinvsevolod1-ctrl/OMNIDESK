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
 * Pull existing Telegram chats (private DMs + groups) into the inbox so the
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
      const dialogs = await client.getDialogs({
        limit: enumLimit,
        folder,
      })
      for (const dialog of dialogs) {
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
  dialog: Awaited<ReturnType<TelegramClient['getDialogs']>>[number],
  ictx: { backfill: boolean; canBackfill: boolean; seenPeers: Set<string> },
): Promise<'skipped' | 'imported' | 'backfilled'> {
  // Skip Telegram's own service/notifications "channel" feed but keep
  // private chats (users) and groups; skip broadcast channels.
  const entity = dialog.entity as Api.User | Api.Chat | Api.Channel | undefined
  if (!entity) return 'skipped'
  const isUser = entity.className === 'User'
  const isGroup =
    entity.className === 'Chat' ||
    (entity.className === 'Channel' &&
      'megagroup' in entity &&
      Boolean(entity.megagroup))
  // Ignore broadcast channels (one-way feeds) and deleted accounts.
  if (!isUser && !isGroup) return 'skipped'
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
 * Pull the COMPLETE message history of a single chat into the inbox — every
 * message and every file, paged all the way back to the very first message
 * (unless TG_BACKFILL_PER_CHAT sets a cap). Idempotent: ingestInbound
 * de-duplicates on providerMessageId, so re-connecting never creates dupes,
 * and countUnread:false means backfilling old chats doesn't light up unread
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
  // Page backwards through history: getMessages returns newest-first, and
  // `offsetId` asks for messages OLDER than that id, so we walk from the most
  // recent message to the first one, one bounded page at a time.
  let offsetId = 0
  let fetched = 0
  try {
    for (;;) {
      if (!ctx.getClient() || ctx.isIngestPaused()) return
      // When a per-chat cap is set, never request more than what's left.
      const remaining =
        TG_BACKFILL_PER_CHAT > 0 ? TG_BACKFILL_PER_CHAT - fetched : Infinity
      if (remaining <= 0) break
      const pageSize = Math.min(TG_BACKFILL_BATCH, remaining)
      const messages = await client.getMessages(entity, {
        limit: pageSize,
        ...(offsetId ? { offsetId } : {}),
      })
      if (!messages || messages.length === 0) break

      // Ingest oldest-first within the page so the stored thread keeps natural
      // chronological order regardless of paging direction.
      for (const msg of [...messages].reverse()) {
        if (!msg) continue
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

      fetched += messages.length
      // The oldest message in this page (last, since newest-first) seeds the
      // next page. A short page means we've reached the first message.
      const oldest = messages[messages.length - 1]
      if (!oldest) break
      offsetId = oldest.id
      if (messages.length < pageSize) break

      // Pace between pages so a long history can't trip the flood limiter.
      await new Promise((r) => setTimeout(r, TG_BACKFILL_PAGE_THROTTLE_MS))
    }
  } catch (err) {
    // Log what we managed to import so a mid-sweep flood-wait is visible; the
    // next reconnect resumes (ingest is idempotent, so no dupes).
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
