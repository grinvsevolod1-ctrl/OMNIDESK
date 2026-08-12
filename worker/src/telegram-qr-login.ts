import { randomUUID } from 'node:crypto'
import { Api } from 'telegram'
import type { TelegramClient } from 'telegram'
import type { Logger } from 'pino'

import { env } from './env.js'
import * as repo from './repo.js'
import { errMessage } from './telegram-errors.js'

/**
 * Everything the QR flow needs from TelegramSession, as a narrow view.
 * Accessors re-read live state so a disconnect mid-flow is seen at the next
 * checkpoint — the same semantics as the direct `this.client` checks the code
 * had before the split.
 */
export interface QrLoginDeps {
  channelId: string
  getClient: () => TelegramClient | null
  authLogger: () => Logger
  /** Re-arm the abandoned-login timeout (waiting for scan / 2FA password). */
  armLoginTimer: () => void
  /** Post-auth bring-up: persist session, mark online, start sync. */
  afterLogin: () => Promise<void>
  /** Shared login failure path: classify, persist error status. */
  fail: (e: unknown) => Promise<{ sessionStatus: repo.SessionStatus }>
  /**
   * begin()-only hooks: QR login always starts a NEW authorization, so the
   * session must reset its string session and rebuild the client. Ownership
   * of both stays in TelegramSession; the flow only asks for them.
   */
  resetForNewAuth: () => Promise<void>
  clearLoginTimer: () => void
  setAttemptId: (id: string) => void
}

/**
 * One-button QR login state machine (auth.exportLoginToken). Extracted from
 * TelegramSession verbatim: token lifecycle (~30s expiry, refresh timer),
 * UpdateLoginToken scan listener, DC migration on LoginTokenMigrateTo, and
 * the 2FA (SESSION_PASSWORD_NEEDED) branch that hands back to the session's
 * password_pending flow.
 *
 * The live deep link is held in worker memory ONLY — like the session string
 * before login, it must never touch the DB in plaintext.
 */
export class TelegramQrLogin {
  private qrLogin: { url: string; expiresAt: number } | null = null
  /** Re-export timer: Telegram QR tokens live ~30s, so refresh while pending. */
  private qrTimer: ReturnType<typeof setTimeout> | null = null
  /** Guards against concurrent finalize attempts (update + poll racing). */
  private qrFinalizing = false
  /** The UpdateLoginToken listener, kept so clear() can detach it. */
  private qrUpdateHandler: ((update: Api.TypeUpdate) => void) | null = null

  constructor(private readonly deps: QrLoginDeps) {}

  /** The current tg://login deep link for the panel, if a QR is pending. */
  current(): { url: string; expiresAt: number } | null {
    return this.qrLogin
  }

  /**
   * One-button QR login entry point (auth.exportLoginToken). No phone, no SMS:
   * the panel shows a QR, the account owner scans it from Telegram → Settings →
   * Devices → Link Desktop Device. Only a 2FA cloud password (if set) remains —
   * that reuses the existing password_pending flow.
   *
   * Token lifecycle: Telegram QR tokens expire in ~30s, so we re-export on a
   * timer while pending. A scan arrives as UpdateLoginToken; re-exporting then
   * returns LoginTokenSuccess (done) or LoginTokenMigrateTo (finish the import
   * on the user's home DC).
   */
  async begin(
    attemptId?: string,
  ): Promise<{ sessionStatus: repo.SessionStatus }> {
    this.deps.setAttemptId(attemptId || randomUUID())
    this.deps.clearLoginTimer()
    this.clear()
    const log = this.deps.authLogger()
    log.info({ stage: 'qr:start' }, 'TG QR login: attempt started')

    await repo.setSession(this.deps.channelId, 'starting')
    // QR login always begins a NEW authorization — ignore any saved session.
    // The session resets its StringSession and rebuilds the client; this flow
    // never owns either.
    try {
      await this.deps.resetForNewAuth()
    } catch (e) {
      log.error(
        { stage: 'qr:connect', err: errMessage(e) },
        'TG QR login: connect failed',
      )
      return this.deps.fail(e)
    }

    this.attachScanListener()

    const status = await this.exportToken()
    if (status !== 'qr_pending') return { sessionStatus: status }
    await repo.setSession(this.deps.channelId, 'qr_pending')
    this.deps.armLoginTimer()
    log.info({ stage: 'qr:pending' }, 'TG QR login: waiting for scan')
    return { sessionStatus: 'qr_pending' }
  }

  /**
   * Attach the scan listener. A scan shows up as UpdateLoginToken — finalize
   * immediately instead of waiting for the next refresh tick. Kept as a named
   * callback so clear() can detach it after login: otherwise every QR attempt
   * leaves a dead handler running on the client for the session's lifetime.
   */
  attachScanListener(): void {
    const client = this.deps.getClient()
    if (!client) return
    this.qrUpdateHandler = (update: Api.TypeUpdate) => {
      if (update instanceof Api.UpdateLoginToken) {
        void this.finalize()
      }
    }
    client.addEventHandler(this.qrUpdateHandler)
  }

  /**
   * Export (or re-export) the QR token. Returns the resulting session status:
   * 'qr_pending' with a fresh deep link, or the completion result when
   * Telegram already considers the token consumed (scan raced the refresh).
   */
  async exportToken(): Promise<repo.SessionStatus> {
    const client = this.deps.getClient()
    if (!client) return 'error'
    const log = this.deps.authLogger()
    const res = await client.invoke(
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
        void this.exportToken().catch((e) =>
          log.warn(
            { stage: 'qr:refresh', err: errMessage(e) },
            'TG QR login: token refresh failed',
          ),
        )
      }, refreshInMs)
      this.qrTimer.unref?.()
      return 'qr_pending'
    }
    // LoginTokenSuccess / LoginTokenMigrateTo both mean "the scan happened".
    return this.complete(res)
  }

  /** A scan arrived — re-export to collect the result and finish the login. */
  private async finalize(): Promise<void> {
    const client = this.deps.getClient()
    if (this.qrFinalizing || !client) return
    this.qrFinalizing = true
    const log = this.deps.authLogger()
    try {
      const res = await client.invoke(
        new Api.auth.ExportLoginToken({
          apiId: env.telegramApiId,
          apiHash: env.telegramApiHash,
          exceptIds: [],
        }),
      )
      if (res instanceof Api.auth.LoginToken) return // not consumed yet
      await this.complete(res)
    } catch (e) {
      if (errMessage(e).includes('SESSION_PASSWORD_NEEDED')) {
        this.clear()
        await repo.setSession(this.deps.channelId, 'password_pending')
        this.deps.armLoginTimer()
        log.info(
          { stage: 'qr:2fa' },
          'TG QR login: scan OK, 2FA cloud password required',
        )
        return
      }
      log.error(
        { stage: 'qr:finalize', err: errMessage(e) },
        'TG QR login: finalize failed',
      )
      await this.deps.fail(e)
    } finally {
      this.qrFinalizing = false
    }
  }

  /** Handle a consumed QR token: import on the right DC, then go online. */
  private async complete(
    res: Api.auth.TypeLoginToken,
  ): Promise<repo.SessionStatus> {
    const client = this.deps.getClient()
    if (!client) return 'error'
    const log = this.deps.authLogger()
    try {
      if (res instanceof Api.auth.LoginTokenMigrateTo) {
        // The account lives on another DC: reconnect there and import the token.
        // _switchDC is a private GramJS API (no public equivalent exists for
        // this flow) — verify it's still there so a library upgrade degrades
        // into a clear error instead of a TypeError mid-login.
        log.info(
          { stage: 'qr:migrate', dcId: res.dcId },
          'TG QR login: migrating to home DC',
        )
        if (typeof client._switchDC !== 'function') {
          throw new Error(
            'GramJS _switchDC is unavailable (library upgrade?) — QR login cannot migrate DC',
          )
        }
        await client._switchDC(res.dcId)
        const imported = await client.invoke(
          new Api.auth.ImportLoginToken({ token: res.token }),
        )
        if (imported instanceof Api.auth.LoginTokenSuccess === false) {
          throw new Error('QR import did not return LoginTokenSuccess')
        }
      }
      this.clear()
      await this.deps.afterLogin()
      log.info({ stage: 'qr:ok' }, 'TG QR login: authorized')
      return 'online'
    } catch (e) {
      if (errMessage(e).includes('SESSION_PASSWORD_NEEDED')) {
        this.clear()
        await repo.setSession(this.deps.channelId, 'password_pending')
        this.deps.armLoginTimer()
        log.info(
          { stage: 'qr:2fa' },
          'TG QR login: scan OK, 2FA cloud password required',
        )
        return 'password_pending'
      }
      log.error(
        { stage: 'qr:complete', err: errMessage(e) },
        'TG QR login: completion failed',
      )
      await this.deps.fail(e)
      return 'error'
    }
  }

  /** Drop the in-memory QR, its refresh timer and the login-token listener. */
  clear(): void {
    this.qrLogin = null
    if (this.qrTimer) {
      clearTimeout(this.qrTimer)
      this.qrTimer = null
    }
    if (this.qrUpdateHandler) {
      // Detach the scan listener — after login it would sit on the client for
      // the whole session lifetime, running on every incoming update.
      try {
        this.deps
          .getClient()
          ?.removeEventHandler(this.qrUpdateHandler, undefined as never)
      } catch {
        /* best-effort */
      }
      this.qrUpdateHandler = null
    }
  }
}
