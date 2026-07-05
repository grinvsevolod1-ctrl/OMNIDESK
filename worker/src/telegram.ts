import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js'
import { computeCheck } from 'telegram/Password.js'
import { returnBigInt } from 'telegram/Helpers.js'
import { getPeerId } from 'telegram/Utils.js'
import type { Dialog } from 'telegram/tl/custom/dialog.js'
import { randomUUID } from 'node:crypto'
import { env, assertTelegramConfigured } from './env.js'
import { logger, type Logger } from './logger.js'
import { describePhone, maskPhone } from './phone.js'
import { gramProxy } from './proxy.js'
import * as repo from './repo.js'
import { onInbound as onAutopilotInbound } from './autopilot.js'

// Per-account outgoing throttle. Telegram aggressively rate-limits (and can ban)
// userbots that send at machine speed; a minimum spacing plus human jitter keeps
// each account's send rate within safe, human-like bounds.
const TG_SEND_MIN_INTERVAL_MS = 1_200
const TG_SEND_JITTER_MS = 800

/**
 * Extract a persistable peer record (kind + id + access_hash) from a GramJS
 * entity. Returns null for entities we can't address (e.g. deleted accounts).
 */
function peerRecordFromEntity(
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
function inputPeerFromRecord(
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

/**
 * One live Telegram (MTProto) user session bound to a channel. The same client
 * instance is reused across login steps so the phoneCodeHash and connection
 * survive between "send code" and "enter password".
 */
export class TelegramSession {
  readonly channelId: string
  readonly managerId: string
  private client: TelegramClient | null = null
  private session: StringSession
  private phone = ''
  private phoneCodeHash = ''
  /** Correlation id for the current login attempt; ties together every log
   * line from "code requested" through code/password submission. */
  private attemptId = ''
  /** Timestamp of the last outgoing send, for per-account rate limiting. */
  private lastSentAt = 0
  /**
   * Soft pause. When true the client stays connected (account alive) but inbound
   * messages and dialog history are NOT written to the inbox. Set via
   * pause/resume jobs and restored from the channel record on (re)start.
   */
  private ingestPaused = false

  constructor(channelId: string, managerId: string) {
    this.channelId = channelId
    this.managerId = managerId
    this.session = new StringSession('')
  }

  /**
   * Toggle the soft pause. Only affects inbound persistence — the live client is
   * left running so the Telegram session stays authorized and healthy.
   */
  setIngestPaused(paused: boolean): void {
    this.ingestPaused = paused
  }

  /** Child logger bound to this channel + current login attempt. */
  private authLogger(): Logger {
    return logger.child({
      scope: 'tg-login',
      channelId: this.channelId,
      attemptId: this.attemptId || '(none)',
    })
  }

  private async buildClient(): Promise<TelegramClient> {
    assertTelegramConfigured()
    const proxy = gramProxy(await repo.getProxyForChannel(this.channelId))
    const client = new TelegramClient(
      this.session,
      env.telegramApiId,
      env.telegramApiHash,
      {
        connectionRetries: 5,
        deviceModel: env.deviceModel,
        systemVersion: env.systemVersion,
        appVersion: env.appVersion,
        proxy,
        autoReconnect: true,
      },
    )
    return client
  }

  /** Persist the current string session (encrypted) to the DB. */
  private async persist(): Promise<void> {
    await repo.saveTgSession(this.channelId, this.session.save())
  }

  /**
   * Start the session. If we already have a saved session, resume and go
   * online. Otherwise begin phone-number login by requesting a code.
   */
  async start(
    phone?: string,
    attemptId?: string,
  ): Promise<{ sessionStatus: repo.SessionStatus }> {
    // New correlation id per attempt (panel can supply one for end-to-end
    // correlation; otherwise we mint our own, e.g. on restart/restore).
    this.attemptId = attemptId || randomUUID()
    const log = this.authLogger()
    // Verbose-but-non-critical lines: visible when auth diagnostics are on
    // (AUTH_DEBUG=1 / LOG_LEVEL=debug / non-prod), otherwise demoted to debug.
    // Critical milestones (code request, delivery branch, errors) stay at info.
    const detail = env.authDebug ? log.info.bind(log) : log.debug.bind(log)
    const t0 = Date.now()
    log.info(
      {
        stage: 'received',
        hasPhoneArg: Boolean(phone),
        resumeOnly: !phone,
        authDebug: env.authDebug,
      },
      'TG login: attempt started',
    )

    await repo.setSession(this.channelId, 'starting')
    const saved = await repo.getTgSession(this.channelId)
    detail(
      { stage: 'session-load', hasSavedSession: Boolean(saved) },
      'TG login: loaded stored session',
    )
    this.session = new StringSession(saved || '')

    // Surface whether a proxy is in front of MTProto — a dead/blocking proxy is
    // a common reason connect() or sendCode() hangs for RU numbers.
    const proxyRow = await repo.getProxyForChannel(this.channelId)
    detail(
      { stage: 'proxy', usingProxy: Boolean(proxyRow), proxyKind: proxyRow?.kind ?? null },
      'TG login: proxy resolved',
    )

    this.client = await this.buildClient()
    try {
      const tc = Date.now()
      await this.client.connect()
      detail(
        { stage: 'connect', ok: true, durationMs: Date.now() - tc },
        'TG login: connected to data-center',
      )
    } catch (e) {
      log.error({ stage: 'connect', err: errMessage(e) }, 'TG login: connect failed')
      return this.fail(e)
    }

    const authorized = await this.client.checkAuthorization().catch(() => false)
    detail(
      { stage: 'check-authorization', authorized },
      'TG login: checked existing authorization',
    )
    if (authorized) {
      await this.afterLogin()
      return { sessionStatus: 'online' }
    }

    if (!phone) {
      log.warn(
        { stage: 'no-phone' },
        'TG login: no phone provided and not authorized — cannot request code',
      )
      await repo.setSession(this.channelId, 'error', {
        lastError: 'Phone number required to start login',
      })
      return { sessionStatus: 'error' }
    }
    this.phone = phone

    // Privacy-safe view of the number + how formatting may differ from E.164.
    const shape = describePhone(phone)
    detail(
      { stage: 'phone-normalization', phone: shape },
      'TG login: phone shape before sending to Telegram',
    )
    if (shape.changedByNormalization) {
      log.warn(
        {
          stage: 'phone-normalization',
          note: 'raw input contains spaces/() /- or no leading +; it is passed to MTProto AS-IS (not reformatted to E.164)',
        },
        'TG login: phone is not in clean E.164 form',
      )
    }

    try {
      // Use the high-level helper instead of a raw auth.SendCode invoke: it
      // transparently follows PHONE_MIGRATE_X redirects and reconnects to the
      // phone number's home data-center. A raw invoke does NOT migrate, so
      // numbers that live on another DC silently never receive a code — which
      // is exactly why "the code doesn't arrive" for some accounts.
      log.info(
        {
          stage: 'sendCode:request',
          service: 'telegram-mtproto',
          method: 'client.sendCode (high-level auth.sendCode, follows PHONE_MIGRATE)',
          phoneMasked: maskPhone(phone),
          apiId: env.telegramApiId, // numeric app id, not a secret
          apiHashPresent: Boolean(env.telegramApiHash),
          forceSMS: false,
        },
        'TG login: requesting login code from Telegram',
      )
      const ts = Date.now()
      const { phoneCodeHash, isCodeViaApp } = await this.client.sendCode(
        { apiId: env.telegramApiId, apiHash: env.telegramApiHash },
        phone,
      )
      this.phoneCodeHash = phoneCodeHash
      // Telegram, not us, decides delivery: if the account already has an active
      // session somewhere, the code is delivered as an in-app message in the
      // "Telegram" service chat (isCodeViaApp). Only with no active session does
      // it fall back to SMS — which is exactly the case that fails for many RU
      // numbers. Record where it went so the wizard tells the manager where to
      // look instead of waiting for an SMS that will never arrive.
      const codeDelivery = isCodeViaApp ? 'app' : 'sms'
      await repo.mergeChannelConfig(this.channelId, { codeDelivery })
      log.info(
        {
          stage: 'sendCode:ok',
          durationMs: Date.now() - ts,
          isCodeViaApp,
          codeDelivery,
          deliveryBranch: isCodeViaApp
            ? 'Telegram delivered the code as an in-app message (service chat) — no SMS will be sent'
            : 'Telegram chose SMS delivery (no active session on this number) — this is the path that often fails for RU numbers',
          phoneCodeHashPresent: Boolean(phoneCodeHash),
        },
        'TG login: code request accepted by Telegram',
      )
      // Persist the (now DC-correct) connection session so a worker restart
      // mid-login can resume on the right data-center.
      await this.persist()
      await repo.setSession(this.channelId, 'code_pending')
      log.info(
        { stage: 'code_pending', totalDurationMs: Date.now() - t0 },
        'TG login: waiting for code entry',
      )
      return { sessionStatus: 'code_pending' }
    } catch (e) {
      log.error(
        { stage: 'sendCode:error', durationMs: Date.now() - t0, err: errMessage(e) },
        'TG login: sendCode failed',
      )
      return this.fail(e)
    }
  }

  /** Submit the SMS/app login code. May transition to password_pending (2FA). */
  async submitCode(
    code: string,
  ): Promise<{ sessionStatus: repo.SessionStatus }> {
    const log = this.authLogger()
    if (!this.client) {
      log.warn({ stage: 'submitCode' }, 'TG login: code submitted but session not started')
      return this.notStarted()
    }
    if (!this.phoneCodeHash) {
      log.warn(
        { stage: 'submitCode' },
        'TG login: code submitted but phoneCodeHash missing (worker likely restarted mid-login)',
      )
      await repo.setSession(this.channelId, 'error', {
        lastError:
          'Login context was lost (worker restarted). Remove the channel and start the connection again.',
      })
      return { sessionStatus: 'error' }
    }
    log.info(
      {
        stage: 'submitCode:request',
        method: 'auth.SignIn',
        codeLength: code.length,
      },
      'TG login: submitting login code',
    )
    try {
      const ts = Date.now()
      await this.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: this.phone,
          phoneCodeHash: this.phoneCodeHash,
          phoneCode: code,
        }),
      )
      log.info(
        { stage: 'submitCode:ok', durationMs: Date.now() - ts },
        'TG login: code accepted',
      )
      await this.afterLogin()
      return { sessionStatus: 'online' }
    } catch (e: unknown) {
      const msg = errMessage(e)
      if (msg.includes('SESSION_PASSWORD_NEEDED')) {
        log.info(
          { stage: 'submitCode:2fa' },
          'TG login: code OK, 2FA cloud password required',
        )
        await repo.setSession(this.channelId, 'password_pending')
        return { sessionStatus: 'password_pending' }
      }
      log.error({ stage: 'submitCode:error', err: msg }, 'TG login: code rejected')
      return this.fail(e)
    }
  }

  /** Submit the Telegram cloud password (2FA) using SRP. */
  async submitPassword(
    password: string,
  ): Promise<{ sessionStatus: repo.SessionStatus }> {
    const log = this.authLogger()
    if (!this.client) {
      log.warn({ stage: 'submitPassword' }, 'TG login: password submitted but session not started')
      return this.notStarted()
    }
    log.info({ stage: 'submitPassword:request', method: 'auth.CheckPassword (SRP)' }, 'TG login: submitting 2FA password')
    try {
      const ts = Date.now()
      const pwd = await this.client.invoke(new Api.account.GetPassword())
      const check = await computeCheck(pwd, password)
      await this.client.invoke(new Api.auth.CheckPassword({ password: check }))
      log.info({ stage: 'submitPassword:ok', durationMs: Date.now() - ts }, 'TG login: 2FA password accepted')
      await this.afterLogin()
      return { sessionStatus: 'online' }
    } catch (e) {
      log.error({ stage: 'submitPassword:error', err: errMessage(e) }, 'TG login: 2FA password rejected')
      return this.fail(e)
    }
  }

  /** After a successful login: persist session, set detail, attach listeners. */
  private async afterLogin(): Promise<void> {
    if (!this.client) return
    await this.persist()
    try {
      const me = (await this.client.getMe()) as Api.User
      const handle = me.username
        ? `@${me.username}`
        : me.phone
          ? `+${me.phone}`
          : 'telegram'
      const name = [me.firstName, me.lastName].filter(Boolean).join(' ')
      await repo.setChannelDetail(this.channelId, name || handle)
    } catch {
      /* non-fatal */
    }
    this.attachHandlers()
    await repo.setSession(this.channelId, 'online', { markConnected: true })
    logger.info({ channelId: this.channelId }, 'Telegram session online')
    // Import existing chats so the inbox isn't empty after connecting. Runs in
    // the background so going "online" isn't blocked by the history fetch.
    void this.syncDialogs()
  }

  /**
   * Pull existing Telegram chats (private DMs + groups) into the inbox so the
   * manager sees their real conversation list, not just messages that arrive
   * after connecting. Idempotent: re-running just refreshes previews/unread.
   */
  private async syncDialogs(): Promise<void> {
    if (!this.client) return
    // Don't backfill history into the inbox while paused.
    if (this.ingestPaused) return
    try {
      const dialogs = await this.client.getDialogs({ limit: 100 })
      let imported = 0
      for (const dialog of dialogs) {
        try {
          // Skip Telegram's own service/notifications "channel" feed but keep
          // private chats (users) and groups; skip broadcast channels.
          const entity = dialog.entity as Api.User | Api.Chat | Api.Channel | undefined
          if (!entity) continue
          const isUser = entity.className === 'User'
          const isGroup =
            entity.className === 'Chat' ||
            (entity.className === 'Channel' &&
              'megagroup' in entity &&
              Boolean(entity.megagroup))
          // Ignore broadcast channels (one-way feeds) and deleted accounts.
          if (!isUser && !isGroup) continue
          if (isUser && 'bot' in entity && entity.bot) {
            // keep bots out unless they messaged — most are noise
            if (!dialog.message?.message) continue
          }

          const { name, handle } = dialogIdentity(dialog, entity, isUser)
          // Public @username for a direct (user) chat, when present. Groups have
          // no single contact username, so leave it null for them.
          const contactUsername =
            isUser && 'username' in entity ? (entity.username ?? null) : null
          // Cache the peer's access_hash for durable addressing after restarts.
          const peerRecord = peerRecordFromEntity(entity)
          if (peerRecord) {
            await repo
              .saveTelegramPeer(this.channelId, handle, peerRecord)
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
            channelId: this.channelId,
            managerId: this.managerId,
            channelType: 'telegram',
            contactName: name,
            contactHandle: handle,
            contactUsername,
            lastMessage,
            lastMessageAt: lastDate,
            unread: dialog.unreadCount ?? 0,
            lastFromMe: fromMe,
          })
          imported++
        } catch (err) {
          logger.warn({ err }, 'telegram dialog import skipped')
        }
      }
      logger.info(
        { channelId: this.channelId, imported },
        'Telegram dialogs synced',
      )
    } catch (err) {
      logger.error({ err }, 'telegram dialog sync failed')
    }
  }

  private attachHandlers(): void {
    if (!this.client) return
    this.client.addEventHandler(async (event: NewMessageEvent) => {
      try {
        // Soft pause: stay connected but don't write inbound to the inbox.
        if (this.ingestPaused) return
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
        const handle = chatId ?? (sender ? String(sender.id) : 'unknown')
        let contactName: string
        // Public @username of the contact, when they have one — captured for a
        // direct (user) chat. Stored separately from the name so the panel can
        // show "Имя · @username". Groups don't have a single contact username.
        let contactUsername: string | null = null
        if (isUserChat || !chat) {
          const u = (chat as Api.User) ?? sender
          contactUsername = u && 'username' in u ? (u.username ?? null) : null
          contactName =
            u && 'firstName' in u
              ? [u.firstName, u.lastName].filter(Boolean).join(' ') ||
                (u.username ? `@${u.username}` : 'Telegram user')
              : 'Telegram user'
        } else {
          // group/supergroup: show the chat title, prefix the sender in body
          contactName =
            chat && 'title' in chat && chat.title ? chat.title : 'Telegram group'
        }

        const senderName =
          sender && 'firstName' in sender
            ? [sender.firstName, sender.lastName].filter(Boolean).join(' ') ||
              (sender.username ? `@${sender.username}` : 'Member')
            : 'Member'
        // Detect any media so the panel can render/stream it. For media without
        // a caption we fall back to a friendly placeholder instead of the old
        // generic "[non-text message]".
        const media = classifyTgMedia(msg)
        const caption = msg.message || (media ? media.placeholder : '[non-text message]')
        const finalBody = isUserChat || !chat ? caption : `${senderName}: ${caption}`

        // Persist this peer's access_hash (keyed on the same handle we store the
        // conversation under) so we can address it after a restart without the
        // volatile entity cache. Best-effort; never blocks ingest.
        const peerRecord =
          peerRecordFromEntity(chat ?? sender) ?? peerRecordFromEntity(sender)
        if (peerRecord) {
          await repo
            .saveTelegramPeer(this.channelId, handle, peerRecord)
            .catch((err) =>
              logger.warn({ err }, 'telegram peer persist failed'),
            )
        }

        const ingest = await repo.ingestInbound({
          channelId: this.channelId,
          managerId: this.managerId,
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

        // Autopilot: only auto-reply in DIRECT (user) chats — never in groups,
        // and only when a new message was actually written (not a dedup replay).
        if (isUserChat && ingest.wrote) {
          await onAutopilotInbound({
            session: this,
            channelId: this.channelId,
            managerId: this.managerId,
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
    this.client.addEventHandler(async (update: Api.TypeUpdate) => {
      try {
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
          await repo.markOutboundReadUpTo(this.channelId, handle, String(maxId))
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
          for (const mid of deletedIds) {
            await repo
              .markInboundDeletedByProviderId(this.channelId, String(mid))
              .catch((err) =>
                logger.warn({ err, mid }, 'telegram mark-deleted failed'),
              )
          }
        }
      } catch (err) {
        logger.warn({ err }, 'telegram read-receipt handler failed')
      }
    })
  }

  /**
   * Send an outgoing message to a stored handle (@username or numeric peer id).
   * When `replyToMsgId` is given the message is sent as a Telegram reply to that
   * message. Returns the new Telegram message id so the caller can persist it
   * (needed to later delete / forward / react to our own message).
   */
  async sendMessage(
    target: string,
    body: string,
    opts?: { replyToMsgId?: number },
  ): Promise<{ providerMessageId: string | null }> {
    if (!this.client) throw new Error('Session not started')
    // Per-account rate limit (see constants): keep a minimum, slightly random
    // spacing between sends so the account never bursts at machine speed.
    const now = Date.now()
    const since = now - this.lastSentAt
    const minGap =
      TG_SEND_MIN_INTERVAL_MS + Math.floor(Math.random() * TG_SEND_JITTER_MS)
    if (since < minGap) {
      await new Promise((r) => setTimeout(r, minGap - since))
    }
    this.lastSentAt = Date.now()
    const entity = await this.resolveTarget(target)
    const sent = await this.client.sendMessage(entity, {
      message: body,
      ...(opts?.replyToMsgId ? { replyTo: opts.replyToMsgId } : {}),
    })
    return { providerMessageId: sent?.id != null ? String(sent.id) : null }
  }

  /**
   * Send read receipts for a chat (marks the whole history read), so the
   * contact sees that the operator read their messages. Best-effort.
   */
  async markRead(target: string): Promise<void> {
    if (!this.client) throw new Error('Session not started')
    const entity = await this.resolveTarget(target)
    await this.client.markAsRead(entity)
  }

  /**
   * Toggle an emoji reaction on a message. Passing an empty emoji clears the
   * reaction. Telegram-only.
   */
  async reactToMessage(
    target: string,
    msgId: number,
    emoji: string,
  ): Promise<void> {
    if (!this.client) throw new Error('Session not started')
    const entity = await this.resolveTarget(target)
    await this.client.invoke(
      new Api.messages.SendReaction({
        peer: entity,
        msgId,
        reaction: emoji
          ? [new Api.ReactionEmoji({ emoticon: emoji })]
          : [new Api.ReactionEmpty()],
      }),
    )
  }

  /**
   * Delete a message. `revoke` deletes it for everyone (both sides) rather than
   * only for this account. Telegram-only.
   */
  async deleteMessage(
    target: string,
    msgId: number,
    revoke = true,
  ): Promise<void> {
    if (!this.client) throw new Error('Session not started')
    const entity = await this.resolveTarget(target)
    await this.client.deleteMessages(entity, [msgId], { revoke })
  }

  /**
   * Forward a message from one chat to another. Returns the new Telegram
   * message id in the destination chat. Telegram-only.
   */
  async forwardMessage(
    fromTarget: string,
    msgId: number,
    toTarget: string,
  ): Promise<{ providerMessageId: string | null }> {
    if (!this.client) throw new Error('Session not started')
    const fromEntity = await this.resolveTarget(fromTarget)
    const toEntity = await this.resolveTarget(toTarget)
    const result = await this.client.forwardMessages(toEntity, {
      messages: [msgId],
      fromPeer: fromEntity,
    })
    const first = Array.isArray(result) ? result[0] : undefined
    return { providerMessageId: first?.id != null ? String(first.id) : null }
  }

  /** Tracks whether we've already refreshed the entity cache this session, so a
   * cache miss only triggers ONE expensive getDialogs sweep, not one per send. */
  private dialogsRefreshedAt = 0

  /**
   * Turn a stored contact_handle back into something GramJS can send to.
   *
   * For a numeric peer id MTProto requires the peer's access_hash, which lives
   * in the session's local entity cache. After a worker restart that cache can
   * be incomplete (the saved string session doesn't carry every entity), so a
   * plain getInputEntity throws "Could not find the input entity for ...". When
   * that happens we refresh the dialog list (which repopulates the cache with
   * access_hashes) and retry, then fall back to getEntity as a last resort.
   */
  private async resolveTarget(
    target: string,
  ): Promise<Api.TypeInputPeer | string> {
    if (target.startsWith('@')) return target
    const client = this.client!
    const peerId = returnBigInt(target)

    // 1) Durable peer cache: rebuild the input peer from a persisted
    // access_hash. This survives restarts and is independent of GramJS's
    // in-memory entity cache (the thing that throws "input entity not found").
    try {
      const stored = await repo.getTelegramPeer(this.channelId, target)
      if (stored) {
        const peer = inputPeerFromRecord(stored)
        if (peer) return peer
      }
    } catch (err) {
      logger.warn(
        { channelId: this.channelId, target, err: errMessage(err) },
        'Telegram peer cache lookup failed',
      )
    }

    // 2) In-memory entity cache.
    try {
      return await client.getInputEntity(peerId)
    } catch (err) {
      logger.warn(
        { channelId: this.channelId, target, err: errMessage(err) },
        'Telegram entity cache miss; refreshing dialogs to resolve peer',
      )
      // 3) Repopulate the entity cache (access_hashes) from the dialog list.
      // Rate-limited to once per 60s so a burst of sends to unknown peers can't
      // spam getDialogs. The sync also persists peers to the durable cache.
      if (Date.now() - this.dialogsRefreshedAt > 60_000) {
        this.dialogsRefreshedAt = Date.now()
        try {
          await this.syncDialogs()
        } catch (e) {
          logger.warn(
            { channelId: this.channelId, err: errMessage(e) },
            'Telegram dialog refresh during resolve failed',
          )
        }
      }
      try {
        return await client.getInputEntity(peerId)
      } catch {
        // 4) Last resort: resolve the full entity (also caches it), persist its
        // access_hash for next time, and derive the input peer from it.
        const entity = (await client.getEntity(peerId)) as
          | Api.User
          | Api.Chat
          | Api.Channel
        const rec = peerRecordFromEntity(entity)
        if (rec) {
          await repo
            .saveTelegramPeer(this.channelId, target, rec)
            .catch(() => {})
        }
        return client.getInputEntity(entity)
      }
    }
  }

  /**
   * Re-download the media bytes for a previously ingested message. `ref` is the
   * descriptor we stored at ingest time ({ peer, msgId }). Returns the raw
   * buffer plus a best-effort MIME/name, or null if the message/media is gone.
   */
  async downloadMedia(
    ref: unknown,
  ): Promise<{ buffer: Buffer; mime: string | null; name: string | null } | null> {
    if (!this.client) throw new Error('Session not started')
    const r = ref as { peer?: string; msgId?: string } | null
    if (!r || !r.peer || !r.msgId) return null

    const entity = await this.resolveTarget(r.peer)
    const messages = await this.client.getMessages(entity, {
      ids: [Number(r.msgId)],
    })
    const message = messages?.[0]
    if (!message || !message.media) return null

    const info = classifyTgMedia(message)
    const buf = (await this.client.downloadMedia(message)) as Buffer | undefined
    if (!buf) return null
    return {
      buffer: Buffer.from(buf),
      mime: info?.mediaMime ?? null,
      name: info?.mediaName ?? null,
    }
  }

  /**
   * List stickers available to this account: recent + favourited. Returns a
   * compact descriptor the panel can render and later send back.
   */
  async listStickers(): Promise<
    Array<{
      id: string
      accessHash: string
      fileReference: string
      emoji: string
      mime: string
    }>
  > {
    if (!this.client) throw new Error('Session not started')
    const out: Array<{
      id: string
      accessHash: string
      fileReference: string
      emoji: string
      mime: string
    }> = []
    const seen = new Set<string>()

    const pushDoc = (doc: Api.TypeDocument, emoji: string) => {
      if (!(doc instanceof Api.Document)) return
      const id = String(doc.id)
      if (seen.has(id)) return
      seen.add(id)
      out.push({
        id,
        accessHash: String(doc.accessHash),
        fileReference: Buffer.from(doc.fileReference).toString('base64'),
        emoji,
        mime: doc.mimeType || 'image/webp',
      })
    }

    const emojiOf = (doc: Api.TypeDocument): string => {
      if (!(doc instanceof Api.Document)) return ''
      for (const a of doc.attributes) {
        if (a instanceof Api.DocumentAttributeSticker) return a.alt || ''
      }
      return ''
    }

    // Favourited stickers first.
    try {
      const fav = await this.client.invoke(
        new Api.messages.GetFavedStickers({ hash: returnBigInt(0) }),
      )
      if (fav instanceof Api.messages.FavedStickers) {
        for (const d of fav.stickers) pushDoc(d, emojiOf(d))
      }
    } catch (err) {
      logger.warn({ err }, 'telegram getFavedStickers failed')
    }

    // Then recently used.
    try {
      const recent = await this.client.invoke(
        new Api.messages.GetRecentStickers({ hash: returnBigInt(0) }),
      )
      if (recent instanceof Api.messages.RecentStickers) {
        for (const d of recent.stickers) pushDoc(d, emojiOf(d))
      }
    } catch (err) {
      logger.warn({ err }, 'telegram getRecentStickers failed')
    }

    return out
  }

  /** Download a sticker's bytes by its document descriptor (for thumbnails). */
  async downloadStickerById(sticker: {
    id: string
    accessHash: string
    fileReference: string
  }): Promise<{ buffer: Buffer; mime: string } | null> {
    if (!this.client) throw new Error('Session not started')
    const location = new Api.InputDocumentFileLocation({
      id: returnBigInt(sticker.id),
      accessHash: returnBigInt(sticker.accessHash),
      fileReference: Buffer.from(sticker.fileReference, 'base64'),
      thumbSize: '',
    })
    const buf = (await this.client.downloadFile(location, {})) as
      | Buffer
      | undefined
    if (!buf || buf.length === 0) return null
    return { buffer: Buffer.from(buf), mime: 'image/webp' }
  }

  /**
   * Send a sticker by its document descriptor (id/accessHash/fileReference).
   * Telegram-only. Shares the same per-account throttle as text sends.
   */
  async sendSticker(
    target: string,
    sticker: { id: string; accessHash: string; fileReference: string },
  ): Promise<void> {
    if (!this.client) throw new Error('Session not started')
    const now = Date.now()
    const since = now - this.lastSentAt
    const minGap =
      TG_SEND_MIN_INTERVAL_MS + Math.floor(Math.random() * TG_SEND_JITTER_MS)
    if (since < minGap) {
      await new Promise((r) => setTimeout(r, minGap - since))
    }
    this.lastSentAt = Date.now()
    const entity = await this.resolveTarget(target)
    const inputDoc = new Api.InputDocument({
      id: returnBigInt(sticker.id),
      accessHash: returnBigInt(sticker.accessHash),
      fileReference: Buffer.from(sticker.fileReference, 'base64'),
    })
    await this.client.sendMessage(entity, { file: inputDoc as never })
  }

  async stop(): Promise<void> {
    try {
      await this.client?.disconnect()
    } finally {
      this.client = null
      await repo.setSession(this.channelId, 'offline')
    }
  }

  async logout(): Promise<void> {
    try {
      await this.client?.invoke(new Api.auth.LogOut())
    } catch {
      /* ignore */
    }
    try {
      await this.client?.disconnect()
    } catch {
      /* ignore */
    }
    this.client = null
    await repo.clearSecrets(this.channelId)
    await repo.setSession(this.channelId, 'logged_out')
  }

  private async fail(e: unknown): Promise<{ sessionStatus: repo.SessionStatus }> {
    const msg = errMessage(e)
    this.authLogger().error(
      {
        stage: 'failure',
        category: classifyError(msg),
        errorCode: extractErrorCode(e),
        err: msg,
      },
      'TG login: failed',
    )
    await repo.setSession(this.channelId, 'error', { lastError: msg })
    return { sessionStatus: 'error' }
  }

  private async notStarted(): Promise<{ sessionStatus: repo.SessionStatus }> {
    await repo.setSession(this.channelId, 'error', {
      lastError: 'Session not started',
    })
    return { sessionStatus: 'error' }
  }
}

function dialogIdentity(
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

/** Recognised media kinds extracted from a Telegram message. */
export interface TgMediaInfo {
  mediaType: 'image' | 'video' | 'video_note' | 'audio' | 'voice' | 'sticker' | 'document'
  mediaMime: string | null
  mediaName: string | null
  /** Friendly placeholder shown when there's no text caption. */
  placeholder: string
}

/**
 * Classify the media carried by a Telegram message into our generic media
 * taxonomy plus a human placeholder. Returns null for plain-text messages.
 */
function classifyTgMedia(msg: Api.Message): TgMediaInfo | null {
  const media = msg.media
  if (!media) return null

  // Photos.
  if (media instanceof Api.MessageMediaPhoto) {
    return {
      mediaType: 'image',
      mediaMime: 'image/jpeg',
      mediaName: null,
      placeholder: '[Фото]',
    }
  }

  // Documents (covers stickers, voice, video notes, audio, video, files).
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document
    const mime =
      doc && 'mimeType' in doc && doc.mimeType ? String(doc.mimeType) : null
    const attrs =
      doc && 'attributes' in doc && Array.isArray(doc.attributes)
        ? doc.attributes
        : []

    let fileName: string | null = null
    let isSticker = false
    let stickerEmoji = ''
    let isRoundVideo = false
    let isVideo = false
    let isVoice = false
    let isAudio = false

    for (const a of attrs) {
      if (a instanceof Api.DocumentAttributeFilename) fileName = a.fileName
      else if (a instanceof Api.DocumentAttributeSticker) {
        isSticker = true
        stickerEmoji = a.alt || ''
      } else if (a instanceof Api.DocumentAttributeVideo) {
        isVideo = true
        if ('round' in a && a.round) isRoundVideo = true
      } else if (a instanceof Api.DocumentAttributeAudio) {
        isAudio = true
        if ('voice' in a && a.voice) isVoice = true
      }
    }

    if (isSticker) {
      return {
        mediaType: 'sticker',
        mediaMime: mime ?? 'image/webp',
        mediaName: null,
        placeholder: stickerEmoji ? `${stickerEmoji} [Стикер]` : '[Стикер]',
      }
    }
    if (isVoice) {
      return {
        mediaType: 'voice',
        mediaMime: mime ?? 'audio/ogg',
        mediaName: null,
        placeholder: '[Голосовое сообщение]',
      }
    }
    if (isRoundVideo) {
      return {
        mediaType: 'video_note',
        mediaMime: mime ?? 'video/mp4',
        mediaName: null,
        placeholder: '[Видеосообщение]',
      }
    }
    if (isAudio) {
      return {
        mediaType: 'audio',
        mediaMime: mime ?? 'audio/mpeg',
        mediaName: fileName,
        placeholder: '[Аудио]',
      }
    }
    if (isVideo) {
      return {
        mediaType: 'video',
        mediaMime: mime ?? 'video/mp4',
        mediaName: fileName,
        placeholder: '[Видео]',
      }
    }
    return {
      mediaType: 'document',
      mediaMime: mime,
      mediaName: fileName,
      placeholder: fileName ? `[Файл: ${fileName}]` : '[Файл]',
    }
  }

  return null
}

function errMessage(e: unknown): string {
  if (e && typeof e === 'object') {
    const anyE = e as { errorMessage?: string; message?: string; seconds?: number }
    if (anyE.errorMessage?.includes('FLOOD_WAIT')) {
      return `FLOOD_WAIT: wait ${anyE.seconds ?? '?'}s before retrying`
    }
    return anyE.errorMessage || anyE.message || String(e)
  }
  return String(e)
}

/** Numeric MTProto error code, if the SDK exposed one (e.g. 420, 400, 406). */
function extractErrorCode(e: unknown): number | null {
  if (e && typeof e === 'object') {
    const anyE = e as { code?: unknown; errorCode?: unknown }
    const c = anyE.code ?? anyE.errorCode
    return typeof c === 'number' ? c : null
  }
  return null
}

/**
 * Bucket the raw Telegram error into a coarse category so logs make the cause
 * obvious at a glance (diagnostics only — does not change handling).
 */
function classifyError(msg: string): string {
  const m = msg.toUpperCase()
  if (m.includes('FLOOD_WAIT')) return 'flood_wait'
  if (m.includes('TIMEOUT') || m.includes('TIMED OUT')) return 'timeout'
  if (m.includes('PHONE_NUMBER_INVALID')) return 'phone_invalid'
  if (m.includes('PHONE_NUMBER_BANNED')) return 'phone_banned'
  if (m.includes('PHONE_NUMBER_FLOOD')) return 'phone_number_flood'
  if (m.includes('PHONE_PASSWORD_FLOOD')) return 'password_flood'
  if (m.includes('PHONE_CODE_INVALID')) return 'code_invalid'
  if (m.includes('PHONE_CODE_EXPIRED')) return 'code_expired'
  if (m.includes('PHONE_CODE_EMPTY')) return 'code_empty'
  if (m.includes('SESSION_PASSWORD_NEEDED')) return '2fa_required'
  if (m.includes('PASSWORD_HASH_INVALID')) return 'password_invalid'
  if (m.includes('PHONE_MIGRATE') || m.includes('NETWORK_MIGRATE')) return 'dc_migrate'
  if (m.includes('API_ID') || m.includes('API_HASH')) return 'api_credentials'
  if (m.includes('CONNECT') || m.includes('SOCKET') || m.includes('PROXY')) return 'connection'
  return 'other'
}
