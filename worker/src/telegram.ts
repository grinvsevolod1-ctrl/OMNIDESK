import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { computeCheck } from 'telegram/Password.js'
import { returnBigInt } from 'telegram/Helpers.js'
import { randomUUID } from 'node:crypto'
import { env, assertTelegramConfigured } from './env.js'
import { logger, type Logger } from './logger.js'
import { describePhone, maskPhone } from './phone.js'
import { gramProxy } from './proxy.js'
import * as repo from './repo.js'
import {
  classifyError,
  errMessage,
  extractErrorCode,
} from './telegram-errors.js'
import {
  TG_SEND_JITTER_MS,
  TG_SEND_MIN_INTERVAL_MS,
  inputPeerFromRecord,
  peerRecordFromEntity,
} from './telegram-config.js'
import type { TgSessionCtx } from './telegram-session-ctx.js'
import { runKickSweep } from './telegram-exclusive.js'
import { syncDialogs } from './telegram-history.js'
import { attachTelegramHandlers } from './telegram-updates.js'
import {
  persistMediaBytes,
  downloadMediaByRef,
  listStickers,
  downloadStickerById,
  sendStickerTo,
  type StickerDescriptor,
} from './telegram-media-io.js'

// The feature modules this monolith was split into re-export their public
// surface here so existing importers (e.g. registry.ts) keep resolving them
// from './telegram.js'.
export { classifyTgMedia } from './telegram-media.js'
export type { TgMediaInfo } from './telegram-media.js'
export { telegramSendFailureReason } from './telegram-errors.js'

/**
 * How often to re-run exclusive-session enforcement (kick foreign Telegram
 * authorizations). A live update handler reacts instantly to new logins; this
 * periodic sweep is the backstop that also retries sessions Telegram refused to
 * terminate while they were still <24h old.
 */
const EXCLUSIVE_SWEEP_MS = 2 * 60_000

/**
 * How long a pending login (code_pending / password_pending) may sit without
 * any code/password submission before the connection is torn down. Telegram
 * login codes expire in ~5 minutes anyway; 10 minutes is generous for a human
 * while guaranteeing an abandoned wizard can't leak a DC connection forever.
 */
const LOGIN_ABANDON_TIMEOUT_MS = 10 * 60_000

/**
 * One live Telegram (MTProto) user session bound to a channel. The same client
 * instance is reused across login steps so the phoneCodeHash and connection
 * survive between "send code" and "enter password".
 *
 * The class owns the LOGIN FLOW and connection lifecycle exclusively — phone,
 * phoneCodeHash and the string session never leave it. Everything else
 * (history sync, live-update handlers, media/sticker IO, kick sweeps) lives in
 * focused sibling modules operating on the narrow TgSessionCtx view.
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
  /**
   * Periodic timer that re-runs exclusive-session enforcement (kick any foreign
   * Telegram authorizations). Set on login, cleared on stop/logout.
   */
  private exclusiveTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Abandoned-login guard. Every wizard that requests a code but never enters
   * it used to leave the MTProto client connected to the DC forever — a leaked
   * connection per abandoned attempt. Armed when we enter code_pending /
   * password_pending, cleared by any code/password submission, resend
   * (re-start), successful login, stop, or logout.
   */
  private loginTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * The narrow view of this session the split-out feature modules operate on.
   * Accessors re-read live state so a disconnect or pause mid-sweep is seen at
   * the next checkpoint, exactly like direct `this.client` checks used to.
   */
  private readonly ctx: TgSessionCtx

  constructor(channelId: string, managerId: string) {
    this.channelId = channelId
    this.managerId = managerId
    this.session = new StringSession('')
    this.ctx = {
      channelId,
      managerId,
      getClient: () => this.client,
      isIngestPaused: () => this.ingestPaused,
      persistMediaBytes: (messageId, msg) =>
        persistMediaBytes(this.client, messageId, msg),
      resolveTarget: (target) => this.resolveTarget(target),
      syncDialogs: (opts) => this.syncDialogs(opts),
      enforceExclusiveSessions: () => this.enforceExclusiveSessions(),
      throttleSend: () => this.throttleSend(),
      senderSession: this,
    }
  }

  /**
   * Toggle the soft pause. Only affects inbound persistence — the live client is
   * left running so the Telegram session stays authorized and healthy.
   */
  setIngestPaused(paused: boolean): void {
    this.ingestPaused = paused
  }

  /** Arm (or re-arm) the abandoned-login timeout. */
  private armLoginTimer(): void {
    this.clearLoginTimer()
    this.loginTimer = setTimeout(() => {
      this.loginTimer = null
      void (async () => {
        this.authLogger().warn(
          { stage: 'login-timeout', timeoutMs: LOGIN_ABANDON_TIMEOUT_MS },
          'TG login: no code/password entered in time — disconnecting pending login',
        )
        try {
          await this.client?.disconnect()
        } catch {
          /* ignore */
        }
        this.client = null
        await repo
          .setSession(this.channelId, 'error', {
            lastError:
              'Время входа истекло: код не был введён. Запросите код повторно.',
          })
          .catch(() => {})
      })()
    }, LOGIN_ABANDON_TIMEOUT_MS)
    // Never keep the worker process alive just for an abandoned wizard.
    this.loginTimer.unref?.()
  }

  private clearLoginTimer(): void {
    if (this.loginTimer) {
      clearTimeout(this.loginTimer)
      this.loginTimer = null
    }
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
    // A fresh start (including a code re-request) supersedes any previous
    // pending-login abandonment timer.
    this.clearLoginTimer()
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

    // A re-start (e.g. "запросить код повторно") must not leak the previous
    // half-logged-in client's DC connection — tear it down first.
    if (this.client) {
      await this.client.disconnect().catch(() => {})
      this.client = null
    }

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
      this.armLoginTimer()
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
    // The admin is actively typing — the login is not abandoned.
    this.clearLoginTimer()
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
        // Re-arm: waiting on the cloud password now, same abandonment risk.
        this.armLoginTimer()
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
    // The admin is actively typing — the login is not abandoned.
    this.clearLoginTimer()
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

  /** (Re)start the periodic exclusive-session enforcement sweep. */
  private startExclusiveTimer(): void {
    if (this.exclusiveTimer) return
    this.exclusiveTimer = setInterval(() => {
      void this.enforceExclusiveSessions()
    }, EXCLUSIVE_SWEEP_MS)
    // Don't keep the event loop alive just for this housekeeping timer.
    this.exclusiveTimer.unref?.()
  }

  /** Stop the periodic exclusive-session enforcement sweep. */
  private stopExclusiveTimer(): void {
    if (this.exclusiveTimer) {
      clearInterval(this.exclusiveTimer)
      this.exclusiveTimer = null
    }
  }

  /**
   * Public one-shot variant called by the God-panel "kick now" job. Runs the
   * same termination logic as the private sweep but is unconditional — it
   * ignores the exclusive-session toggle so the admin can always manually kick
   * without enabling the automatic mode.
   *
   * Returns { kicked, skipped } counts for the job result payload.
   */
  async kickForeignSessionsNow(): Promise<{ kicked: number; skipped: number }> {
    return runKickSweep(this.client, this.channelId)
  }

  /**
   * Keep this account authorized ONLY on our own session. Gated on the
   * God-panel "exclusive session" flag (default ON). Best-effort, non-fatal.
   */
  private async enforceExclusiveSessions(): Promise<void> {
    if (!this.client) return

    let enabled = true
    try {
      enabled = await repo.getTelegramExclusiveSetting()
    } catch {
      enabled = true
    }
    if (!enabled) return

    await runKickSweep(this.client, this.channelId)
  }

  /** After a successful login: persist session, set detail, attach listeners. */
  private async afterLogin(): Promise<void> {
    if (!this.client) return
    this.clearLoginTimer()
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
    attachTelegramHandlers(this.ctx)
    await repo.setSession(this.channelId, 'online', { markConnected: true })
    logger.info({ channelId: this.channelId }, 'Telegram session online')
    // Enforce exclusive-session control: immediately terminate any OTHER active
    // authorizations on this account, then keep enforcing on a periodic sweep so
    // anyone who logs in later is kicked automatically. Runs in the background so
    // going "online" isn't blocked by the account.getAuthorizations round-trip.
    void this.enforceExclusiveSessions()
    this.startExclusiveTimer()
    // Import existing chats so the inbox isn't empty after connecting. Runs in
    // the background so going "online" isn't blocked by the history fetch. This
    // path also backfills recent per-chat message history so opened threads show
    // real conversation, not just messages that arrive after connecting.
    void this.syncDialogs({ backfill: true })
  }

  /** Import dialogs + optional history backfill (see telegram-history.ts). */
  private async syncDialogs(opts?: { backfill?: boolean }): Promise<void> {
    return syncDialogs(this.ctx, opts)
  }

  /**
   * Per-account send pacing: keep a minimum, slightly random spacing between
   * sends so the account never bursts at machine speed. Shared by text sends
   * and stickers.
   */
  private async throttleSend(): Promise<void> {
    const now = Date.now()
    const since = now - this.lastSentAt
    const minGap =
      TG_SEND_MIN_INTERVAL_MS + Math.floor(Math.random() * TG_SEND_JITTER_MS)
    if (since < minGap) {
      await new Promise((r) => setTimeout(r, minGap - since))
    }
    this.lastSentAt = Date.now()
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
    await this.throttleSend()
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
   * SenderSession adapter for the autopilot's optional typing presence.
   * The autopilot duck-types `sendTyping?(target, on)` — this was silently
   * never called before because only `setTyping` existed, so auto-replies
   * arrived with no "печатает…" indicator. `on=false` sends an explicit
   * cancel action instead of waiting for Telegram's ~6s auto-expiry.
   */
  async sendTyping(target: string, on: boolean): Promise<void> {
    if (!this.client) throw new Error('Session not started')
    const entity = await this.resolveTarget(target)
    await this.client.invoke(
      new Api.messages.SetTyping({
        peer: entity,
        action: on
          ? new Api.SendMessageTypingAction()
          : new Api.SendMessageCancelAction(),
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
   * Edit the text of an already-sent message (Telegram only). The contact sees
   * the native "edited" mark, exactly like editing in the official client.
   */
  async editMessage(
    target: string,
    msgId: number,
    body: string,
  ): Promise<void> {
    if (!this.client) throw new Error('Session not started')
    const entity = await this.resolveTarget(target)
    await this.client.editMessage(entity, { message: msgId, text: body })
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
   * descriptor we stored at ingest time ({ peer, msgId }).
   */
  async downloadMedia(
    ref: unknown,
  ): Promise<{ buffer: Buffer; mime: string | null; name: string | null } | null> {
    return downloadMediaByRef(this.ctx, ref)
  }

  /** List stickers available to this account: recent + favourited. */
  async listStickers(): Promise<StickerDescriptor[]> {
    return listStickers(this.client)
  }

  /** Download a sticker's bytes by its document descriptor (for thumbnails). */
  async downloadStickerById(sticker: {
    id: string
    accessHash: string
    fileReference: string
  }): Promise<{ buffer: Buffer; mime: string } | null> {
    return downloadStickerById(this.client, sticker)
  }

  /**
   * Send a sticker by its document descriptor (id/accessHash/fileReference).
   * Telegram-only. Shares the same per-account throttle as text sends.
   */
  async sendSticker(
    target: string,
    sticker: { id: string; accessHash: string; fileReference: string },
  ): Promise<void> {
    return sendStickerTo(this.ctx, target, sticker)
  }

  async stop(): Promise<void> {
    this.stopExclusiveTimer()
    this.clearLoginTimer()
    try {
      await this.client?.disconnect()
    } finally {
      this.client = null
      await repo.setSession(this.channelId, 'offline')
    }
  }

  async logout(): Promise<void> {
    this.stopExclusiveTimer()
    this.clearLoginTimer()
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
