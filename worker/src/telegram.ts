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
import { classifyTgMedia, type TgMediaInfo } from './telegram-media.js'
import {
  classifyError,
  errMessage,
  extractErrorCode,
  telegramSendFailureReason,
} from './telegram-errors.js'
import {
  MEDIA_MAX_STORE_BYTES,
  TG_BACKFILL_BATCH,
  TG_BACKFILL_MAX_CHATS,
  TG_BACKFILL_MEDIA_THROTTLE_MS,
  TG_BACKFILL_PAGE_THROTTLE_MS,
  TG_BACKFILL_PER_CHAT,
  TG_BACKFILL_THROTTLE_MS,
  TG_DIALOG_FOLDERS,
  TG_DIALOG_LIMIT,
  TG_DIALOG_LIMIT_ALL,
  TG_SEND_JITTER_MS,
  TG_SEND_MIN_INTERVAL_MS,
  TG_STORE_MEDIA,
  TG_STORE_MEDIA_BACKFILL,
  inputPeerFromRecord,
  peerRecordFromEntity,
} from './telegram-config.js'

// Media/error classification helpers were split into focused sibling modules;
// re-export their public surface so existing importers (e.g. registry.ts) keep
// resolving them from './telegram.js'.
export { classifyTgMedia } from './telegram-media.js'
export type { TgMediaInfo } from './telegram-media.js'
export { telegramSendFailureReason } from './telegram-errors.js'

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
    // the background so going "online" isn't blocked by the history fetch. This
    // path also backfills recent per-chat message history so opened threads show
    // real conversation, not just messages that arrive after connecting.
    void this.syncDialogs({ backfill: true })
  }

  /**
   * Pull existing Telegram chats (private DMs + groups) into the inbox so the
   * manager sees their real conversation list, not just messages that arrive
   * after connecting. Idempotent: re-running just refreshes previews/unread.
   */
  private async syncDialogs(opts?: { backfill?: boolean }): Promise<void> {
    if (!this.client) return
    // Don't backfill history into the inbox while paused.
    if (this.ingestPaused) return

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
      if (!this.client || this.ingestPaused) break
      try {
        const dialogs = await this.client.getDialogs({
          limit: enumLimit,
          folder,
        })
        for (const dialog of dialogs) {
          try {
            const handled = await this.importDialog(dialog, {
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
      { channelId: this.channelId, imported, backfilled },
      'Telegram dialogs synced (all folders)',
    )
  }

  /**
   * Import one dialog into the inbox and (optionally) backfill its full history.
   * Returns what happened so the caller can keep accurate counters and pace the
   * flood-safe throttle only when a backfill actually ran.
   */
  private async importDialog(
    dialog: Awaited<ReturnType<TelegramClient['getDialogs']>>[number],
    ctx: { backfill: boolean; canBackfill: boolean; seenPeers: Set<string> },
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
    if (ctx.seenPeers.has(peerKey)) return 'skipped'
    ctx.seenPeers.add(peerKey)

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

    // Backfill the COMPLETE message history so opened threads show the full
    // conversation. TG_BACKFILL_MAX_CHATS === 0 means "no cap" (every chat).
    if (ctx.backfill && dialog.message && ctx.canBackfill) {
      await this.backfillDialogHistory(entity, handle, isUser, name)
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
  private async backfillDialogHistory(
    entity: Api.User | Api.Chat | Api.Channel,
    handle: string,
    isUser: boolean,
    contactName: string,
  ): Promise<void> {
    if (!this.client) return
    // Page backwards through history: getMessages returns newest-first, and
    // `offsetId` asks for messages OLDER than that id, so we walk from the most
    // recent message to the first one, one bounded page at a time.
    let offsetId = 0
    let fetched = 0
    try {
      for (;;) {
        if (!this.client || this.ingestPaused) return
        // When a per-chat cap is set, never request more than what's left.
        const remaining =
          TG_BACKFILL_PER_CHAT > 0 ? TG_BACKFILL_PER_CHAT - fetched : Infinity
        if (remaining <= 0) break
        const pageSize = Math.min(TG_BACKFILL_BATCH, remaining)
        const messages = await this.client.getMessages(entity, {
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
            channelId: this.channelId,
            managerId: this.managerId,
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
            await this.persistMediaBytes(histIngest.messageId, msg)
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
        { channelId: this.channelId, handle, fetched, err: errMessage(err) },
        'telegram history backfill interrupted',
      )
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

        // Persist the media bytes now (from the message we already hold), so the
        // file is ours forever even if the contact deletes/edits it later.
        if (media) {
          await this.persistMediaBytes(ingest.messageId, msg)
        }

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
              this.channelId,
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
              await this.persistMediaBytes(result.messageId, editMsg)
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
   * Show the "typing…" indicator to the contact. Telegram auto-expires the
   * indicator after ~6s, so the panel re-sends it while the operator keeps
   * typing. Best-effort — never throws into the job runner.
   */
  async setTyping(target: string): Promise<void> {
    if (!this.client) throw new Error('Session not started')
    const entity = await this.resolveTarget(target)
    await this.client.invoke(
      new Api.messages.SetTyping({
        peer: entity,
        action: new Api.SendMessageTypingAction(),
      }),
    )
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
   * Download the media bytes straight from a message we already hold (live event
   * or backfill page) and persist them in Postgres, so the file survives the
   * contact later deleting/editing the original. Best-effort and idempotent: it
   * skips when storage is off, the message already has stored bytes, the file is
   * over the size cap, or the download fails. Never throws into ingest.
   */
  private async persistMediaBytes(
    messageId: string | null,
    msg: Api.Message,
  ): Promise<void> {
    if (!messageId || !TG_STORE_MEDIA || !this.client) return
    if (!msg.media) return
    try {
      if (!(await repo.messageNeedsMediaBytes(messageId))) return
      const buf = (await this.client.downloadMedia(msg)) as Buffer | undefined
      if (!buf || !buf.length) return
      if (buf.byteLength > MEDIA_MAX_STORE_BYTES) return
      const info = classifyTgMedia(msg)
      await repo.storeMessageMediaBytes(
        messageId,
        Buffer.from(buf),
        info?.mediaMime ?? null,
        info?.mediaName ?? null,
      )
    } catch (err) {
      logger.warn({ err, messageId }, 'telegram media persist failed')
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

