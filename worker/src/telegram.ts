import { TelegramClient, Api } from 'teleproto'
import { StringSession } from 'teleproto/sessions/index.js'
import { returnBigInt } from 'teleproto/Helpers.js'
import { randomUUID } from 'node:crypto'
import { env, assertTelegramConfigured } from './env.js'
import { logger, type Logger } from './logger.js'
import { gramProxy } from './proxy.js'
import * as repo from './repo.js'
import { errMessage } from './telegram-errors.js'
import {
  bringSessionOnline,
  failLogin,
  logoutSession,
  stopSession,
  teardownZombieConnection,
  type TgLifecycleDeps,
} from './telegram-lifecycle.js'
import { TelegramSendThrottle } from './telegram-throttle.js'
import { TelegramHealthMonitor } from './telegram-health.js'
import { TelegramPhoneLogin } from './telegram-phone-login.js'
import { TelegramQrLogin } from './telegram-qr-login.js'
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
  createPersonalTargetResolver,
  deletePersonalDialog,
  downloadPersonalAvatar,
  downloadPersonalMedia,
  getPersonalHistory,
  getPersonalProfile,
  listPersonalDialogs,
  sendPersonalFile,
  startPersonalDialog,
  updatePersonalProfile,
  updatePersonalUsername,
  type PersonalDialogDTO,
  type PersonalMessageDTO,
  type PersonalProfileDTO,
  type StartDialogResult,
} from './personal.js'
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
 * The class owns the CONNECTION LIFECYCLE exclusively — the client and the
 * string session never leave it. The login flows are driven by sibling
 * state machines (telegram-phone-login.ts, telegram-qr-login.ts) that hold
 * their volatile secrets (phone, phoneCodeHash, QR deep link) in worker
 * memory only and hand every transition back via callbacks. Everything else
 * (history sync, live-update handlers, media/sticker IO, kick sweeps) lives in
 * focused sibling modules operating on the narrow TgSessionCtx view.
 */
export class TelegramSession {
  readonly channelId: string
  readonly managerId: string
  /**
   * Личный режим (god-панель, type='telegram_personal'): аккаунт живёт ВНЕ
   * панели — никакого ingest в inbox, никакого syncDialogs, никакого кика
   * чужих сессий (владелец пользуется своим телефоном параллельно).
   * Переписка читается живьём через worker/src/personal.ts.
   */
  readonly personal: boolean
  private client: TelegramClient | null = null
  private session: StringSession
  /** Correlation id for the current login attempt; ties together every log
   * line from "code requested" through code/password submission. */
  private attemptId = ''
  /**
   * Send pacing + FLOOD_WAIT cooldown state machine (telegram-throttle.ts).
   * Owns lastSentAt / floodCooldownUntil; the session only delegates.
   */
  private readonly sendThrottle: TelegramSendThrottle
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
   * QR-login state machine (see telegram-qr-login.ts). Holds the live deep
   * link in worker memory only; hands 2FA and completion back to this class
   * via callbacks so login state never leaves the session.
   */
  private readonly qr: TelegramQrLogin
  /**
   * Phone/code login state machine (see telegram-phone-login.ts). Owns the
   * phone number and phoneCodeHash in worker memory only; the session keeps
   * the client and connection lifecycle and receives every transition back
   * via callbacks.
   */
  private readonly phoneLogin: TelegramPhoneLogin
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

  constructor(
    channelId: string,
    managerId: string,
    opts?: { personal?: boolean },
  ) {
    this.channelId = channelId
    this.managerId = managerId
    this.personal = Boolean(opts?.personal)
    this.session = new StringSession('')
    this.sendThrottle = new TelegramSendThrottle(
      channelId,
      () => this.client !== null,
    )
    this.health = new TelegramHealthMonitor({
      channelId,
      getClient: () => this.client,
      onZombie: () => this.onZombieConnection(),
    })
    this.qr = new TelegramQrLogin({
      channelId,
      getClient: () => this.client,
      authLogger: () => this.authLogger(),
      armLoginTimer: () => this.armLoginTimer(),
      afterLogin: () => this.afterLogin(),
      fail: (e) => this.fail(e),
      resetForNewAuth: () => this.resetForNewAuth(),
      clearLoginTimer: () => this.clearLoginTimer(),
      setAttemptId: (id) => {
        this.attemptId = id
      },
    })
    this.phoneLogin = new TelegramPhoneLogin({
      channelId,
      authLogger: () => this.authLogger(),
      setAttemptId: (id) => {
        this.attemptId = id
      },
      clearLoginTimer: () => this.clearLoginTimer(),
      armLoginTimer: () => this.armLoginTimer(),
      clearQr: () => this.qr.clear(),
      getClient: () => this.client,
      setClient: (client) => {
        this.client = client
      },
      setSession: (session) => {
        this.session = session
      },
      buildClient: () => this.buildClient(),
      persist: () => this.persist(),
      afterLogin: () => this.afterLogin(),
      fail: (e) => this.fail(e),
      notStarted: () => this.notStarted(),
    })
    // Личный аккаунт использует ЧИСТО in-memory резолвер: durable peer-cache
    // в Postgres оставил бы на сервере след из контактов владельца.
    this.resolveTarget = this.personal
      ? createPersonalTargetResolver(() => this.client)
      : createTargetResolver({
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
        this.qr.clear()
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
    return this.phoneLogin.start(phone, attemptId)
  }

  /** Current QR deep link for the panel to render, if a QR login is pending. */
  getQr(): { url: string; expiresAt: number } | null {
    return this.qr.current()
  }

  /**
   * One-button QR login (see telegram-qr-login.ts for the full flow: token
   * lifecycle, scan listener, DC migration, 2FA hand-off).
   */
  async startQr(
    attemptId?: string,
  ): Promise<{ sessionStatus: repo.SessionStatus }> {
    return this.qr.begin(attemptId)
  }

  /**
   * Reset to a brand-new authorization: blank string session, fresh client,
   * connected. Used by QR login, which never resumes a saved session.
   */
  private async resetForNewAuth(): Promise<void> {
    this.session = new StringSession('')
    if (this.client) {
      await this.client.disconnect().catch(() => {})
      this.client = null
    }
    this.client = await this.buildClient()
    await this.client.connect()
  }

  async submitCode(
    code: string,
  ): Promise<{ sessionStatus: repo.SessionStatus }> {
    return this.phoneLogin.submitCode(code)
  }

  /** Submit the Telegram cloud password (2FA) using SRP. */
  async submitPassword(
    password: string,
  ): Promise<{ sessionStatus: repo.SessionStatus }> {
    return this.phoneLogin.submitPassword(password)
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
   * The dependency bundle the lifecycle-transition module operates on
   * (see telegram-lifecycle.ts). Built lazily so accessors always observe
   * live state, mirroring the other split-out modules' contracts.
   */
  private get lifecycleDeps(): TgLifecycleDeps {
    return {
      channelId: this.channelId,
      personal: this.personal,
      ctx: this.ctx,
      getClient: () => this.client,
      setClient: (client) => {
        this.client = client
      },
      authLogger: () => this.authLogger(),
      persist: () => this.persist(),
      clearLoginTimer: () => this.clearLoginTimer(),
      clearQr: () => this.qr.clear(),
      startExclusiveTimer: () => this.startExclusiveTimer(),
      stopExclusiveTimer: () => this.stopExclusiveTimer(),
      startHealth: () => this.health.start(),
      stopHealth: () => this.health.stop(),
      enforceExclusiveSessions: () => this.enforceExclusiveSessions(),
      syncDialogs: (opts) => this.syncDialogs(opts),
      recoverUndeliveredOutbound: () => this.recoverUndeliveredOutbound(),
    }
  }

  /** Zombie teardown (see telegram-lifecycle.ts). */
  private async onZombieConnection(): Promise<void> {
    return teardownZombieConnection(this.lifecycleDeps)
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
    // Личный аккаунт: владелец продолжает пользоваться своим телефоном и
    // другими устройствами — кикать их категорически нельзя.
    if (this.personal) return

    let enabled = true
    try {
      enabled = await repo.getTelegramExclusiveSetting()
    } catch {
      enabled = true
    }
    if (!enabled) return

    await runKickSweep(this.client, this.channelId)
  }

  /** Post-login bring-up (see telegram-lifecycle.ts). */
  private async afterLogin(): Promise<void> {
    return bringSessionOnline(this.lifecycleDeps)
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

  /** Send pacing + FLOOD_WAIT cooldown (see telegram-throttle.ts). */
  private throttleSend(): Promise<void> {
    return this.sendThrottle.throttle()
  }

  /** Delegate to the throttle module (see telegram-throttle.ts). */
  private tripFloodCooldown(err: unknown): void {
    this.sendThrottle.tripFloodCooldown(err)
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

  /* ---------------- Personal mode (god-панель, см. personal.ts) ---------------- */

  /** Guard: personal reads/sends are only valid on a personal session. */
  private personalClient(): TelegramClient {
    if (!this.personal) throw new Error('Not a personal session')
    if (!this.client) throw new Error('Session not started')
    return this.client
  }

  /** Live dialog list (personal mode). Pure read — nothing persisted. */
  async personalDialogs(limit?: number): Promise<PersonalDialogDTO[]> {
    return listPersonalDialogs(this.personalClient(), limit)
  }

  /** Live history page for one dialog (personal mode). Pure read. */
  async personalHistory(
    peer: string,
    opts?: { beforeId?: number; limit?: number },
  ): Promise<PersonalMessageDTO[]> {
    return getPersonalHistory(
      this.personalClient(),
      this.resolveTarget,
      peer,
      opts,
    )
  }

  /** Peer avatar bytes (personal mode). Pure read. */
  async personalAvatar(peer: string): Promise<Buffer | null> {
    return downloadPersonalAvatar(this.personalClient(), this.resolveTarget, peer)
  }

  /** Live media bytes for one message (personal mode). Pure read. */
  async personalMedia(
    peer: string,
    messageId: number,
  ): Promise<{ buffer: Buffer; mime: string; name: string | null } | null> {
    return downloadPersonalMedia(
      this.personalClient(),
      this.resolveTarget,
      peer,
      messageId,
    )
  }

  /**
   * Delete a whole dialog (personal mode). `revoke` also removes the history
   * for the other participant (user dialogs); channels/supergroups are left.
   */
  async personalDeleteDialog(peer: string, revoke: boolean): Promise<void> {
    return deletePersonalDialog(
      this.personalClient(),
      this.resolveTarget,
      peer,
      revoke,
    )
  }

  /** Own profile snapshot (personal mode). Pure read. */
  async personalProfile(): Promise<PersonalProfileDTO> {
    return getPersonalProfile(this.personalClient())
  }

  /** Update own first/last name / about in Telegram (personal mode). */
  async personalUpdateProfile(patch: {
    firstName?: string
    lastName?: string
    about?: string
  }): Promise<void> {
    return updatePersonalProfile(this.personalClient(), patch)
  }

  /** Update own @username (empty string removes it). Personal mode. */
  async personalSetUsername(username: string): Promise<void> {
    return updatePersonalUsername(this.personalClient(), username)
  }

  /** Message a brand-new peer first, by @username or phone. Throttled. */
  async personalStartDialog(
    target: string,
    text: string,
  ): Promise<StartDialogResult> {
    const client = this.personalClient()
    await this.throttleSend()
    try {
      return await startPersonalDialog(client, target, text)
    } catch (err) {
      this.tripFloodCooldown(err)
      throw err
    }
  }

  /** Send a photo/document from the personal composer. Throttled like text. */
  async personalSendFile(
    peer: string,
    file: {
      buffer: Buffer
      name: string
      mime: string | null
      asPhoto: boolean
      caption?: string
      replyToMsgId?: number
    },
  ): Promise<{ providerMessageId: string | null }> {
    const client = this.personalClient()
    const entity = await this.resolveTarget(peer)
    await this.throttleSend()
    try {
      return await sendPersonalFile(client, entity, file)
    } catch (err) {
      this.tripFloodCooldown(err)
      throw err
    }
  }

  /** Graceful stop: keep the authorization, go offline (telegram-lifecycle.ts). */
  async stop(): Promise<void> {
    return stopSession(this.lifecycleDeps)
  }

  /** Full logout: revoke authorization, wipe secrets (telegram-lifecycle.ts). */
  async logout(): Promise<void> {
    return logoutSession(this.lifecycleDeps)
  }

  private async fail(e: unknown): Promise<{ sessionStatus: repo.SessionStatus }> {
    return failLogin(
      { channelId: this.channelId, authLogger: () => this.authLogger() },
      e,
    )
  }

  private async notStarted(): Promise<{ sessionStatus: repo.SessionStatus }> {
    await repo.setSession(this.channelId, 'error', {
      lastError: 'Session not started',
    })
    return { sessionStatus: 'error' }
  }
}
