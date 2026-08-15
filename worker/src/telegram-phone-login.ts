import { TelegramClient, Api } from 'teleproto'
import { StringSession } from 'teleproto/sessions/index.js'
import { computeCheck } from 'teleproto/Password.js'
import { randomUUID } from 'node:crypto'
import { env } from './env.js'
import type { Logger } from './logger.js'
import { describePhone, maskPhone } from './phone.js'
import * as repo from './repo.js'
import { errMessage } from './telegram-errors.js'

/**
 * Everything the phone/code login flow needs from TelegramSession. Mirrors the
 * TelegramQrLogin pattern: the session keeps ownership of the client and the
 * connection lifecycle; this module drives the auth.sendCode → auth.SignIn →
 * (optional) 2FA CheckPassword sequence and hands every transition back
 * through these callbacks.
 */
export interface PhoneLoginDeps {
  channelId: string
  /** Child logger bound to channel + current attempt (owned by the session). */
  authLogger: () => Logger
  /** Record the correlation id for the new attempt (used by authLogger). */
  setAttemptId: (id: string) => void
  clearLoginTimer: () => void
  armLoginTimer: () => void
  /** A fresh phone login supersedes any pending QR attempt. */
  clearQr: () => void
  getClient: () => TelegramClient | null
  setClient: (client: TelegramClient | null) => void
  /** Swap in the (re)loaded string session before building the client. */
  setSession: (session: StringSession) => void
  buildClient: () => Promise<TelegramClient>
  /** Persist the current string session (encrypted) to the DB. */
  persist: () => Promise<void>
  afterLogin: () => Promise<void>
  fail: (e: unknown) => Promise<{ sessionStatus: repo.SessionStatus }>
  notStarted: () => Promise<{ sessionStatus: repo.SessionStatus }>
}

/**
 * Phone-number login state machine (split out of telegram.ts verbatim).
 *
 * Owns the login-attempt state that must never touch the DB in plaintext:
 * the phone number and the phoneCodeHash live in worker memory only, for
 * exactly as long as the attempt is in flight. The same instance is reused
 * across login steps so the phoneCodeHash survives between "send code" and
 * "enter code / password".
 */
export class TelegramPhoneLogin {
  private phone = ''
  private phoneCodeHash = ''

  constructor(private readonly deps: PhoneLoginDeps) {}

  /**
   * Start the session. If we already have a saved session, resume and go
   * online. Otherwise begin phone-number login by requesting a code.
   */
  async start(
    phone?: string,
    attemptId?: string,
  ): Promise<{ sessionStatus: repo.SessionStatus }> {
    const d = this.deps
    // New correlation id per attempt (panel can supply one for end-to-end
    // correlation; otherwise we mint our own, e.g. on restart/restore).
    d.setAttemptId(attemptId || randomUUID())
    // A fresh start (including a code re-request) supersedes any previous
    // pending-login abandonment timer and any pending QR.
    d.clearLoginTimer()
    d.clearQr()
    const log = d.authLogger()
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

    await repo.setSession(d.channelId, 'starting')
    const saved = await repo.getTgSession(d.channelId)
    detail(
      { stage: 'session-load', hasSavedSession: Boolean(saved) },
      'TG login: loaded stored session',
    )
    d.setSession(new StringSession(saved || ''))

    // Surface whether a proxy is in front of MTProto — a dead/blocking proxy is
    // a common reason connect() or sendCode() hangs for RU numbers.
    const proxyRow = await repo.getProxyForChannel(d.channelId)
    detail(
      { stage: 'proxy', usingProxy: Boolean(proxyRow), proxyKind: proxyRow?.kind ?? null },
      'TG login: proxy resolved',
    )

    // A re-start (e.g. "запросить код повторно") must not leak the previous
    // half-logged-in client's DC connection — tear it down first.
    const prev = d.getClient()
    if (prev) {
      await prev.disconnect().catch(() => {})
      d.setClient(null)
    }

    const client = await d.buildClient()
    d.setClient(client)
    try {
      const tc = Date.now()
      await client.connect()
      detail(
        { stage: 'connect', ok: true, durationMs: Date.now() - tc },
        'TG login: connected to data-center',
      )
    } catch (e) {
      log.error({ stage: 'connect', err: errMessage(e) }, 'TG login: connect failed')
      return d.fail(e)
    }

    const authorized = await client.checkAuthorization().catch(() => false)
    detail(
      { stage: 'check-authorization', authorized },
      'TG login: checked existing authorization',
    )
    if (authorized) {
      await d.afterLogin()
      return { sessionStatus: 'online' }
    }

    if (!phone) {
      log.warn(
        { stage: 'no-phone' },
        'TG login: no phone provided and not authorized — cannot request code',
      )
      await repo.setSession(d.channelId, 'error', {
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
      const { phoneCodeHash, isCodeViaApp } = await client.sendCode(
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
      await repo.mergeChannelConfig(d.channelId, { codeDelivery })
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
      await d.persist()
      await repo.setSession(d.channelId, 'code_pending')
      d.armLoginTimer()
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
      return d.fail(e)
    }
  }

  /** Submit the SMS/app login code. May transition to password_pending (2FA). */
  async submitCode(
    code: string,
  ): Promise<{ sessionStatus: repo.SessionStatus }> {
    const d = this.deps
    const log = d.authLogger()
    // The admin is actively typing — the login is not abandoned.
    d.clearLoginTimer()
    const client = d.getClient()
    if (!client) {
      log.warn({ stage: 'submitCode' }, 'TG login: code submitted but session not started')
      return d.notStarted()
    }
    if (!this.phoneCodeHash) {
      log.warn(
        { stage: 'submitCode' },
        'TG login: code submitted but phoneCodeHash missing (worker likely restarted mid-login)',
      )
      await repo.setSession(d.channelId, 'error', {
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
      await client.invoke(
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
      await d.afterLogin()
      return { sessionStatus: 'online' }
    } catch (e: unknown) {
      const msg = errMessage(e)
      if (msg.includes('SESSION_PASSWORD_NEEDED')) {
        log.info(
          { stage: 'submitCode:2fa' },
          'TG login: code OK, 2FA cloud password required',
        )
        await repo.setSession(d.channelId, 'password_pending')
        // Re-arm: waiting on the cloud password now, same abandonment risk.
        d.armLoginTimer()
        return { sessionStatus: 'password_pending' }
      }
      log.error({ stage: 'submitCode:error', err: msg }, 'TG login: code rejected')
      return d.fail(e)
    }
  }

  /** Submit the Telegram cloud password (2FA) using SRP. */
  async submitPassword(
    password: string,
  ): Promise<{ sessionStatus: repo.SessionStatus }> {
    const d = this.deps
    const log = d.authLogger()
    // The admin is actively typing — the login is not abandoned.
    d.clearLoginTimer()
    const client = d.getClient()
    if (!client) {
      log.warn({ stage: 'submitPassword' }, 'TG login: password submitted but session not started')
      return d.notStarted()
    }
    log.info({ stage: 'submitPassword:request', method: 'auth.CheckPassword (SRP)' }, 'TG login: submitting 2FA password')
    try {
      const ts = Date.now()
      const pwd = await client.invoke(new Api.account.GetPassword())
      const check = await computeCheck(pwd, password)
      await client.invoke(new Api.auth.CheckPassword({ password: check }))
      log.info({ stage: 'submitPassword:ok', durationMs: Date.now() - ts }, 'TG login: 2FA password accepted')
      await d.afterLogin()
      return { sessionStatus: 'online' }
    } catch (e) {
      log.error({ stage: 'submitPassword:error', err: errMessage(e) }, 'TG login: 2FA password rejected')
      return d.fail(e)
    }
  }
}
