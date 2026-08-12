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
  extractFloodWaitSeconds,
} from './telegram-errors.js'
import {
  TG_SEND_JITTER_MS,
  TG_SEND_MIN_INTERVAL_MS,
} from './telegram-config.js'
import { TelegramHealthMonitor } from './telegram-health.js'
import { recoverUndeliveredOutbound } from './telegram-recovery.js'
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
  sendVoiceTo,
  type StickerDescriptor,
} from './telegram-media-io.js'
import { createTargetResolver } from './telegram-peers.js'
import {
  sendMessageTo,
  markReadIn,
  setTypingIn,
  reactToMessageIn,
  deleteMessageIn,
  editMessageIn,
  forwardMessageIn,
  type TgMessagingDeps,
} from './telegram-messaging.js'

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
   * Deadline (epoch ms) until which ALL sends are refused after a significant
   * FLOOD_WAIT. Every send attempted during an active flood window extends the
   * ban server-side — so once Telegram says "wait N seconds", the whole
   * channel cools down instead of letting the next queued message re-trip it.
   */
  private floodCooldownUntil = 0
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
   * Zombie-connection detector (see telegram-health.ts). Started on login,
   * stopped on stop/logout; hands teardown back via onZombieConnection so
   * login state never leaves this class.
   */
  private readonly health: TelegramHealthMonitor
  /**
   * Abandoned-login guard. Every wizard that requests a code but never enters
   * it used to leave the MTProto client connected to the DC forever — a leaked
   * connection per abandoned attempt. Armed when we enter code_pending /
   * password_pending, cleared by any code/password submission, resend
   * (re-start), successful login, stop, or logout.
   */
  private loginTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Live QR-login state (tg://login deep link + expiry). Held in worker memory
   * only — like the session string before login, it must never touch the DB in
   * plaintext. The panel fetches it via the worker's internal HTTP API.
   */
  private qrLogin: { url: string; expiresAt: number } | null = null
  /** Re-export timer: Telegram QR tokens live ~30s, so refresh while pending. */
  private qrTimer: ReturnType<typeof setTimeout> | null = null
  /** Guards against concurrent finalize attempts (update + poll racing). */
  private qrFinalizing = false
  /** The UpdateLoginToken listener, kept so clearQr can detach it. */
  private qrUpdateHandler: ((update: Api.TypeUpdate) => void) | null = null
  /**
   * The narrow view of this session the split-out feature modules operate on.
   * Accessors re-read live state so a disconnect or pause mid-sweep is seen at
   * the next checkpoint, exactly like direct `this.client` checks used to.
   */
  private readonly ctx: TgSessionCtx
  /**
   * Peer resolution lives in telegram-peers.ts; the resolver keeps its own
   * "one getDialogs sweep per minute" rate-limit state in closure. Built in
   * the constructor (not a field initializer) so channelId is already set.
   */
  private readonly resolveTarget: (
    target: string,
  ) => Promise<Api.TypeInputPeer | string>

  constructor(channelId: string, managerId: string) {
    this.channelId = channelId
    this.managerId = managerId
    this.session = new StringSession('')
    this.health = new TelegramHealthMonitor({
      channelId,
      getClient: () => this.client,
      onZombie: () => this.onZombieConnection(),
    })
    this.resolveTarget = createTargetResolver({
      channelId,
      getClient: () => this.client,
      syncDialogs: () => this.syncDialogs(),
    })
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
        this.clearQr()
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
        // Pace reconnect attempts: GramJS's default retry delay hammers the
        // DC (and the proxy) back-to-back, which both slows recovery and
        // looks bot-like. 3s between attempts is what official clients use.
        retryDelay: 3_000,
        // Retry transient RPC failures once instead of surfacing every blip
        // as a failed job; anything persistent still fails fast.
        requestRetries: 2,
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
    // pending-login abandonment timer and any pending QR.
    this.clearLoginTimer()
    this.clearQr()
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
  /** Current QR deep link for the panel to render, if a QR login is pending. */
  getQr(): { url: string; expiresAt: number } | null {
    return this.qrLogin
  }

  /**
   * One-button QR login (auth.exportLoginToken). No phone, no SMS: the panel
   * shows a QR, the account owner scans it from Telegram → Settings → Devices →
   * Link Desktop Device. Only a 2FA cloud password (if set) remains — that
   * reuses the existing password_pending flow.
   *
   * Token lifecycle: Telegram QR tokens expire in ~30s, so we re-export on a
   * timer while pending. A scan arrives as UpdateLoginToken; re-exporting then
   * returns LoginTokenSuccess (done) or LoginTokenMigrateTo (finish the import
   * on the user's home DC).
   */
  async startQr(
    attemptId?: string,
  ): Promise<{ sessionStatus: repo.SessionStatus }> {
    this.attemptId = attemptId || randomUUID()
    this.clearLoginTimer()
    this.clearQr()
    const log = this.authLogger()
    log.info({ stage: 'qr:start' }, 'TG QR login: attempt started')

    await repo.setSession(this.channelId, 'starting')
    // QR login always begins a NEW authorization — ignore any saved session.
    this.session = new StringSession('')

    if (this.client) {
      await this.client.disconnect().catch(() => {})
      this.client = null
    }
    this.client = await this.buildClient()
    try {
      await this.client.connect()
    } catch (e) {
      log.error({ stage: 'qr:connect', err: errMessage(e) }, 'TG QR login: connect failed')
      return this.fail(e)
    }

    // A scan shows up as UpdateLoginToken — finalize immediately instead of
    // waiting for the next refresh tick. Kept as a named callback so clearQr
    // can detach it after login: otherwise every QR attempt leaves a dead
    // handler running on the client for the session's whole lifetime.
    this.qrUpdateHandler = (update: Api.TypeUpdate) => {
      if (update instanceof Api.UpdateLoginToken) {
        void this.finalizeQr()
      }
    }
    this.client.addEventHandler(this.qrUpdateHandler)

    const status = await this.exportQrToken()
    if (status !== 'qr_pending') return { sessionStatus: status }
    await repo.setSession(this.channelId, 'qr_pending')
    this.armLoginTimer()
    log.info({ stage: 'qr:pending' }, 'TG QR login: waiting for scan')
    return { sessionStatus: 'qr_pending' }
  }

  /**
   * Export (or re-export) the QR token. Returns the resulting session status:
   * 'qr_pending' with a fresh deep link, or 'online' when Telegram already
   * considers the token consumed (scan raced the refresh).
   */
  private async exportQrToken(): Promise<repo.SessionStatus> {
    if (!this.client) return 'error'
    const log = this.authLogger()
    const res = await this.client.invoke(
      new Api.auth.ExportLoginToken({
        apiId: env.telegramApiId,
        apiHash: env.telegramApiHash,
        exceptIds: [],
      }),
    )
    if (res instanceof Api.auth.LoginToken) {
      const b64 = Buffer.from(res.token).toString('base64url')
      this.qrLogin = {
        url: `tg://login?token=${b64}`,
        expiresAt: res.expires * 1000,
      }
      // Refresh ~5s before expiry so the panel never renders a dead QR.
      if (this.qrTimer) clearTimeout(this.qrTimer)
      const refreshInMs = Math.max(5_000, res.expires * 1000 - Date.now() - 5_000)
      this.qrTimer = setTimeout(() => {
        void this.exportQrToken().catch((e) =>
          log.warn({ stage: 'qr:refresh', err: errMessage(e) }, 'TG QR login: token refresh failed'),
        )
      }, refreshInMs)
      this.qrTimer.unref?.()
      return 'qr_pending'
    }
    // LoginTokenSuccess / LoginTokenMigrateTo both mean "the scan happened".
    return this.completeQr(res)
  }

  /** A scan arrived — re-export to collect the result and finish the login. */
  private async finalizeQr(): Promise<void> {
    if (this.qrFinalizing || !this.client) return
    this.qrFinalizing = true
    const log = this.authLogger()
    try {
      const res = await this.client.invoke(
        new Api.auth.ExportLoginToken({
          apiId: env.telegramApiId,
          apiHash: env.telegramApiHash,
          exceptIds: [],
        }),
      )
      if (res instanceof Api.auth.LoginToken) return // not consumed yet
      await this.completeQr(res)
    } catch (e) {
      if (errMessage(e).includes('SESSION_PASSWORD_NEEDED')) {
        this.clearQr()
        await repo.setSession(this.channelId, 'password_pending')
        this.armLoginTimer()
        log.info({ stage: 'qr:2fa' }, 'TG QR login: scan OK, 2FA cloud password required')
        return
      }
      log.error({ stage: 'qr:finalize', err: errMessage(e) }, 'TG QR login: finalize failed')
      await this.fail(e)
    } finally {
      this.qrFinalizing = false
    }
  }

  /** Handle a consumed QR token: import on the right DC, then go online. */
  private async completeQr(
    res: Api.auth.TypeLoginToken,
  ): Promise<repo.SessionStatus> {
    if (!this.client) return 'error'
    const log = this.authLogger()
    try {
      if (res instanceof Api.auth.LoginTokenMigrateTo) {
        // The account lives on another DC: reconnect there and import the token.
        // _switchDC is a private GramJS API (no public equivalent exists for
        // this flow) — verify it's still there so a library upgrade degrades
        // into a clear error instead of a TypeError mid-login.
        log.info({ stage: 'qr:migrate', dcId: res.dcId }, 'TG QR login: migrating to home DC')
        if (typeof this.client._switchDC !== 'function') {
          throw new Error(
            'GramJS _switchDC is unavailable (library upgrade?) — QR login cannot migrate DC',
          )
        }
        await this.client._switchDC(res.dcId)
        const imported = await this.client.invoke(
          new Api.auth.ImportLoginToken({ token: res.token }),
        )
        if (imported instanceof Api.auth.LoginTokenSuccess === false) {
          throw new Error('QR import did not return LoginTokenSuccess')
        }
      }
      this.clearQr()
      await this.afterLogin()
      log.info({ stage: 'qr:ok' }, 'TG QR login: authorized')
      return 'online'
    } catch (e) {
      if (errMessage(e).includes('SESSION_PASSWORD_NEEDED')) {
        this.clearQr()
        await repo.setSession(this.channelId, 'password_pending')
        this.armLoginTimer()
        log.info({ stage: 'qr:2fa' }, 'TG QR login: scan OK, 2FA cloud password required')
        return 'password_pending'
      }
      log.error({ stage: 'qr:complete', err: errMessage(e) }, 'TG QR login: completion failed')
      await this.fail(e)
      return 'error'
    }
  }

  /** Drop the in-memory QR, its refresh timer and the login-token listener. */
  private clearQr(): void {
    this.qrLogin = null
    if (this.qrTimer) {
      clearTimeout(this.qrTimer)
      this.qrTimer = null
    }
    if (this.qrUpdateHandler) {
      // Detach the scan listener — after login it would sit on the client for
      // the whole session lifetime, running on every incoming update.
      try {
        this.client?.removeEventHandler(this.qrUpdateHandler, undefined as never)
      } catch {
        /* best-effort */
      }
      this.qrUpdateHandler = null
    }
  }

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
   * Zombie-connection teardown, invoked by the health monitor after two
   * consecutive failed pings: mark degraded and drop the client so revival
   * rebuilds a fresh connection instead of reusing the dead transport.
   */
  private async onZombieConnection(): Promise<void> {
    this.health.stop()
    this.stopExclusiveTimer()
    try {
      await this.client?.disconnect()
    } catch {
      /* transport already dead */
    }
    this.client = null
    await repo
      .setSession(this.channelId, 'error', {
        lastError: 'Соединение с Telegram перестало отвечать (health ping)',
      })
      .catch(() => {})
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
    // Zombie detection: probe the connection on a fixed cadence so a dead
    // transport is noticed within minutes, not on the next failed send.
    this.health.start()
    // Gap recovery note: GramJS's client.catchUp() is an unimplemented stub
    // (function body is literally `// TODO`), so updates.getDifference cannot
    // be leaned on here. The offline gap is instead recovered by the dialog
    // sync below: per-chat watermarks (scripts/105) make it fetch ONLY the
    // messages missed while offline, not the whole history.
    // Import existing chats so the inbox isn't empty after connecting. Runs in
    // the background so going "online" isn't blocked by the history fetch. This
    // path also backfills recent per-chat message history so opened threads show
    // real conversation, not just messages that arrive after connecting. With
    // per-chat watermarks (scripts/105) a reconnect only fetches the offline
    // delta, not the whole history again.
    void this.syncDialogs({ backfill: true })
    // Delivery recovery: resend outbound messages that were written while this
    // account was disconnected and never reached Telegram. Background, so going
    // online isn't blocked by resends.
    void this.recoverUndeliveredOutbound()
  }

  /** Post-reconnect delivery recovery (see telegram-recovery.ts). */
  private async recoverUndeliveredOutbound(): Promise<void> {
    return recoverUndeliveredOutbound({
      channelId: this.channelId,
      getClient: () => this.client,
      resolveTarget: (target) => this.resolveTarget(target),
      sendMessage: (target, body) => this.sendMessage(target, body),
    })
  }

  /** Import dialogs + optional history backfill (see telegram-history.ts). */
  private async syncDialogs(opts?: { backfill?: boolean }): Promise<void> {
    return syncDialogs(this.ctx, opts)
  }

  /**
   * Per-account send pacing: keep a minimum, slightly random spacing between
   * sends so the account never bursts at machine speed. Shared by text sends
   * and stickers.
   *
   * Atomic via a promise chain: queued sends and direct callers (autopilot
   * replies bypass the job queue) can hit this concurrently, and the previous
   * read-sleep-write version let both read the same lastSentAt and pass
   * together — a two-message burst, exactly what the throttle exists to
   * prevent. Chaining serializes the gap computation itself.
   */
  private throttleTail: Promise<void> = Promise.resolve()

  private throttleSend(): Promise<void> {
    const next = this.throttleTail.then(async () => {
      // Flood gate first: while a FLOOD_WAIT window is active every further
      // attempt would extend the ban, so refuse outright. The error text keeps
      // the FLOOD_WAIT_<secs> shape so telegramSendFailureReason renders the
      // proper human explanation on the failed message row.
      const coolMs = this.floodCooldownUntil - Date.now()
      if (coolMs > 0) {
        throw new Error(`FLOOD_WAIT_${Math.ceil(coolMs / 1000)} (local cooldown)`)
      }
      const since = Date.now() - this.lastSentAt
      const minGap =
        TG_SEND_MIN_INTERVAL_MS + Math.floor(Math.random() * TG_SEND_JITTER_MS)
      if (since < minGap) {
        await new Promise((r) => setTimeout(r, minGap - since))
      }
      this.lastSentAt = Date.now()
    })
    // Keep the chain alive even if a caller's continuation throws later.
    this.throttleTail = next.catch(() => {})
    return next
  }

  /**
   * Inspect a send failure and, when Telegram answered FLOOD_WAIT with a
   * meaningful duration, put the whole channel into cooldown: sends are gated
   * locally (see throttleSend) and the panel shows `rate_limited` until the
   * window passes, when the status flips back to online automatically.
   * Short waits (< 30s) are left to the normal per-send pacing.
   */
  private tripFloodCooldown(err: unknown): void {
    const secs = extractFloodWaitSeconds(err)
    if (!secs || secs < 30) return
    this.floodCooldownUntil = Date.now() + secs * 1000
    logger.warn(
      { channelId: this.channelId, floodWaitSecs: secs },
      'channel entering flood cooldown',
    )
    void repo.setSession(this.channelId, 'rate_limited').catch(() => {})
    const timer = setTimeout(() => {
      // Only restore if nothing else changed the state meanwhile and the
      // client is still alive (a stop/logout must not be overwritten).
      if (this.client && Date.now() >= this.floodCooldownUntil) {
        void repo.setSession(this.channelId, 'online').catch(() => {})
      }
    }, secs * 1000)
    timer.unref?.()
  }

  /**
   * Send an outgoing message to a stored handle (@username or numeric peer id).
   * When `replyToMsgId` is given the message is sent as a Telegram reply to that
   * message. When `scheduleAt` (unix seconds) is given, Telegram schedules the
   * send SERVER-SIDE (messages.sendMessage schedule_date) — it delivers at that
   * time even if the worker is down. Returns the new Telegram message id so the
   * caller can persist it (needed to later delete / forward / react to it).
   */
  /**
   * The messaging dependency bundle handed to the split-out outgoing-ops
   * module (telegram-messaging.ts). Throttling and flood cooldown stay owned
   * by the class; the module only invokes them.
   */
  private get messagingDeps(): TgMessagingDeps {
    return {
      getClient: () => this.client,
      resolveTarget: (target) => this.resolveTarget(target),
      throttleSend: () => this.throttleSend(),
      tripFloodCooldown: (err) => this.tripFloodCooldown(err),
    }
  }

  async sendMessage(
    target: string,
    body: string,
    opts?: { replyToMsgId?: number; scheduleAt?: number },
  ): Promise<{ providerMessageId: string | null }> {
    return sendMessageTo(this.messagingDeps, target, body, opts)
  }

  /**
   * Send read receipts for a chat (marks the whole history read), so the
   * contact sees that the operator read their messages. Best-effort.
   */
  async markRead(target: string): Promise<void> {
    return markReadIn(this.messagingDeps, target)
  }

  /**
   * Show the "typing…" indicator to the contact. Telegram auto-expires the
   * indicator after ~6s, so the panel re-sends it while the operator keeps
   * typing. Best-effort — never throws into the job runner.
   */
  async setTyping(target: string): Promise<void> {
    return setTypingIn(this.messagingDeps, target, true)
  }

  /**
   * SenderSession adapter for the autopilot's optional typing presence.
   * The autopilot duck-types `sendTyping?(target, on)`. `on=false` sends an
   * explicit cancel action instead of waiting for Telegram's ~6s auto-expiry.
   */
  async sendTyping(target: string, on: boolean): Promise<void> {
    return setTypingIn(this.messagingDeps, target, on)
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
    return reactToMessageIn(this.messagingDeps, target, msgId, emoji)
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
    return deleteMessageIn(this.messagingDeps, target, msgId, revoke)
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
    return editMessageIn(this.messagingDeps, target, msgId, body)
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
    return forwardMessageIn(this.messagingDeps, fromTarget, msgId, toTarget)
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
    try {
      return await sendStickerTo(this.ctx, target, sticker)
    } catch (err) {
      this.tripFloodCooldown(err)
      throw err
    }
  }

  /**
   * Send a voice note recorded in the panel composer. Telegram renders it as a
   * native voice bubble (waveform + duration), not a file attachment.
   */
  async sendVoice(
    target: string,
    audio: { buffer: Buffer; durationSec: number },
  ): Promise<{ providerMessageId: string | null }> {
    try {
      return await sendVoiceTo(this.ctx, target, audio)
    } catch (err) {
      this.tripFloodCooldown(err)
      throw err
    }
  }

  async stop(): Promise<void> {
    this.stopExclusiveTimer()
    this.health.stop()
    this.clearLoginTimer()
    this.clearQr()
    try {
      await this.client?.disconnect()
    } finally {
      this.client = null
      await repo.setSession(this.channelId, 'offline')
    }
  }

  async logout(): Promise<void> {
    this.stopExclusiveTimer()
    this.health.stop()
    this.clearLoginTimer()
    this.clearQr()
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
