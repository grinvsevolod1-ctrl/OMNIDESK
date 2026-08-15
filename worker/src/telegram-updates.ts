import { Api } from 'teleproto'
import { NewMessage, type NewMessageEvent } from 'teleproto/events/index.js'
import { getPeerId } from 'teleproto/Utils.js'
import { logger } from './logger.js'
import * as repo from './repo.js'
import { onInbound as onAutopilotInbound } from './autopilot.js'
import { classifyTgMedia } from './telegram-media.js'
import { peerRecordFromEntity } from './telegram-config.js'
import type { TgSessionCtx } from './telegram-session-ctx.js'

/**
 * Live-update handlers for one Telegram session: new inbound messages, read
 * receipts, foreign-login reactions, deletions and edits. Extracted verbatim
 * from the TelegramSession monolith; registered once after a successful login.
 */
export function attachTelegramHandlers(ctx: TgSessionCtx): void {
  const client = ctx.getClient()
  if (!client) return

  client.addEventHandler(async (event: NewMessageEvent) => {
    try {
      // Soft pause: stay connected but don't write inbound to the inbox.
      if (ctx.isIngestPaused()) return
      const msg = event.message
      if (msg.out) return // ignore our own outgoing
      // Key the conversation by the CHAT, so group messages map to one thread
      // and line up with the synced dialog list (same handle scheme).
      const chatId = msg.chatId ? String(msg.chatId) : null
      const chat = (await msg.getChat().catch(() => null)) as
        | Api.User
        | Api.Chat
        | Api.Channel
        | null
      const sender = (await msg.getSender().catch(() => null)) as Api.User | null

      const isUserChat = chat?.className === 'User'
      // Только личные чаты: группы, супергруппы и каналы не попадают в инбокс
      // вообще — это мусор для продавца (chat === null трактуем как личку:
      // сущность могла не подгрузиться, а терять сообщения клиента нельзя).
      if (chat && !isUserChat) return
      const handle = chatId ?? (sender ? String(sender.id) : 'unknown')
      // После фильтра выше здесь только личные чаты — контакт и его
      // @username берутся из сущности пользователя (или отправителя).
      const u = (chat as Api.User | null) ?? sender
      const contactUsername =
        u && 'username' in u ? (u.username ?? null) : null
      const contactName =
        u && 'firstName' in u
          ? [u.firstName, u.lastName].filter(Boolean).join(' ') ||
            (u.username ? `@${u.username}` : 'Telegram user')
          : 'Telegram user'

      // Detect any media so the panel can render/stream it. For media without
      // a caption we fall back to a friendly placeholder instead of the old
      // generic "[non-text message]".
      const media = classifyTgMedia(msg)
      const finalBody =
        msg.message || (media ? media.placeholder : '[non-text message]')

      // Persist this peer's access_hash (keyed on the same handle we store the
      // conversation under) so we can address it after a restart without the
      // volatile entity cache. Best-effort; never blocks ingest.
      const peerRecord =
        peerRecordFromEntity(chat ?? sender) ?? peerRecordFromEntity(sender)
      if (peerRecord) {
        await repo
          .saveTelegramPeer(ctx.channelId, handle, peerRecord)
          .catch((err) =>
            logger.warn({ err }, 'telegram peer persist failed'),
          )
      }

      const ingest = await repo.ingestInbound({
        channelId: ctx.channelId,
        managerId: ctx.managerId,
        channelType: 'telegram',
        contactName,
        contactHandle: handle,
        contactUsername,
        body: finalBody,
        // Store the Telegram message id for EVERY inbound message so the
        // panel can later reply to / react to / delete / forward it.
        providerMessageId: String(msg.id),
        ...(media
          ? {
              mediaType: media.mediaType,
              mediaMime: media.mediaMime,
              mediaName: media.mediaName,
              // Enough to re-fetch the exact message and download its media
              // on demand. peer = the conversation handle we keyed on.
              mediaRef: { peer: handle, msgId: String(msg.id) },
            }
          : {}),
      })

      // Persist the media bytes now (from the message we already hold), so the
      // file is ours forever even if the contact deletes/edits it later.
      if (media) {
        await ctx.persistMediaBytes(ingest.messageId, msg)
      }

      // Autopilot: only auto-reply in DIRECT (user) chats — never in groups,
      // and only when a new message was actually written (not a dedup replay).
      if (isUserChat && ingest.wrote) {
        await onAutopilotInbound({
          session: ctx.senderSession,
          channelId: ctx.channelId,
          managerId: ctx.managerId,
          channelType: 'telegram',
          conversationId: ingest.conversationId,
          contactHandle: handle,
          text: msg.message || '',
          isFirstInbound: ingest.isFirstInbound,
        })
      }
    } catch (err) {
      logger.error({ err }, 'telegram inbound handler failed')
    }
  }, new NewMessage({}))

  // Read receipts for OUR outgoing messages. Telegram sends a "read history
  // outbox" update carrying the peer and the max message id the contact has
  // read; we mark every outbound message up to that id as 'read' so the panel
  // shows blue ticks. Registered as a raw-update handler (no event builder).
  client.addEventHandler(async (update: Api.TypeUpdate) => {
    try {
      // Someone just logged a NEW device/client into this account. In
      // exclusive-session mode terminate it right away (best-effort — Telegram
      // may refuse until it's 24h old, in which case the periodic sweep gets
      // it later). This is the instant reaction path.
      if (update instanceof Api.UpdateNewAuthorization) {
        void ctx.enforceExclusiveSessions()
      }

      let handle: string | null = null
      let maxId: number | null = null
      if (update instanceof Api.UpdateReadHistoryOutbox) {
        handle = String(getPeerId(update.peer))
        maxId = update.maxId
      } else if (update instanceof Api.UpdateReadChannelOutbox) {
        handle = String(
          getPeerId(new Api.PeerChannel({ channelId: update.channelId })),
        )
        maxId = update.maxId
      }
      if (handle && maxId != null) {
        await repo.markOutboundReadUpTo(ctx.channelId, handle, String(maxId))
      }

      // Inbound deletions: the contact (or we, from a linked device) deleted
      // one or more messages. Telegram only sends the message ids — match
      // them to our stored provider_message_id within this channel and stamp
      // a soft-delete that PRESERVES the content (so nothing is lost; the
      // panel just shows a "deleted" marker). Covers both ordinary chats
      // (UpdateDeleteMessages) and channels/supergroups
      // (UpdateDeleteChannelMessages).
      let deletedIds: number[] | null = null
      if (update instanceof Api.UpdateDeleteMessages) {
        deletedIds = update.messages
      } else if (update instanceof Api.UpdateDeleteChannelMessages) {
        deletedIds = update.messages
      }
      if (deletedIds && deletedIds.length) {
        // Single batched UPDATE: a "clear chat" revokes hundreds of ids at
        // once — a query per id would hammer the pool for no reason.
        await repo
          .markInboundDeletedByProviderIds(
            ctx.channelId,
            deletedIds.map((mid) => String(mid)),
          )
          .catch((err) =>
            logger.warn(
              { err, count: deletedIds.length },
              'telegram mark-deleted failed',
            ),
          )
      }

      // Edits: the contact (or we, from a linked device) edited a message.
      // Telegram sends the FULL new message; we snapshot the prior version into
      // history and overwrite the live row, keeping the complete before/after
      // trail. Covers ordinary chats (UpdateEditMessage) and channels/
      // supergroups (UpdateEditChannelMessage).
      let editMsg: Api.Message | null = null
      if (
        update instanceof Api.UpdateEditMessage &&
        update.message instanceof Api.Message
      ) {
        editMsg = update.message
      } else if (
        update instanceof Api.UpdateEditChannelMessage &&
        update.message instanceof Api.Message
      ) {
        editMsg = update.message
      }
      if (editMsg) {
        try {
          const media = classifyTgMedia(editMsg)
          const newBody =
            editMsg.message || (media ? media.placeholder : '')
          const result = await repo.recordMessageEditByProviderId(
            ctx.channelId,
            String(editMsg.id),
            {
              body: newBody,
              mediaType: media?.mediaType ?? null,
              mediaMime: media?.mediaMime ?? null,
              mediaName: media?.mediaName ?? null,
            },
          )
          // If the media itself changed, persist the new bytes so both the old
          // (in history) and the new version are viewable.
          if (result && result.mediaChanged && media) {
            await ctx.persistMediaBytes(result.messageId, editMsg)
          }
        } catch (err) {
          logger.warn(
            { err, msgId: String(editMsg.id) },
            'telegram record-edit failed',
          )
        }
      }
    } catch (err) {
      logger.warn({ err }, 'telegram read-receipt handler failed')
    }
  })
}
