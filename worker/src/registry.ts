import { logger } from './logger.js'
import { TelegramSession, telegramSendFailureReason } from './telegram.js'
import {
  isConnectionSendFailure,
  OFFLINE_SEND_REASON,
} from './telegram-errors.js'
import * as repo from './repo.js'

/**
 * The worker only drives Telegram (MTProto) sessions. WhatsApp is served
 * entirely by the official Cloud API through the Next.js webhook — there is no
 * Baileys/WhatsApp Web socket here anymore. VK and MAX are likewise webhook /
 * long-poll based and live in the Next.js app. Any job that somehow targets a
 * non-Telegram channel is treated as a safe no-op so a stale queue entry can
 * never crash the worker.
 */
type AnySession = TelegramSession

/**
 * Holds every live session keyed by channelId and routes job actions to the
 * right session. Survives for the lifetime of the worker process.
 */
class Registry {
  private sessions = new Map<string, AnySession>()

  private ensure(channel: repo.ChannelRecord): AnySession {
    let s = this.sessions.get(channel.id)
    if (s) return s
    s = new TelegramSession(channel.id, channel.manager_id)
    this.sessions.set(channel.id, s)
    return s
  }

  get(channelId: string): AnySession | undefined {
    return this.sessions.get(channelId)
  }

  /**
   * True for channels this worker is responsible for. Only Telegram runs here;
   * everything else (WhatsApp Cloud, VK, MAX, livechat) is owned by Next.js.
   */
  private isWorkerManaged(channel: repo.ChannelRecord): boolean {
    return channel.type === 'telegram'
  }

  async handleJob(job: repo.JobRecord): Promise<Record<string, unknown>> {
    const channel = await repo.getChannel(job.channel_id)
    if (!channel) throw new Error('Channel not found')
    // Non-Telegram channels are not driven by this worker. Defensive no-op in
    // case a stale job slips through (e.g. a WhatsApp Cloud / VK / MAX job).
    if (!this.isWorkerManaged(channel)) {
      logger.warn(
        { channelId: channel.id, type: channel.type, action: job.action },
        'Ignoring job for non-Telegram channel (not worker-managed)',
      )
      return { skipped: `non-telegram channel (${channel.type})` }
    }
    const session = this.ensure(channel)
    const payload = job.payload || {}

    // Carry the persisted soft-pause flag into the (possibly freshly created)
    // session so a paused channel that reconnects/restarts stays paused.
    session.setIngestPaused(Boolean(channel.ingest_paused))

    switch (job.action) {
      case 'start': {
        return session.start(
          (payload.phone as string) || channel.phone || undefined,
          typeof payload.attemptId === 'string' ? payload.attemptId : undefined,
        )
      }
      case 'start_qr': {
        // One-button QR login: no phone/SMS, the owner scans from Telegram →
        // Settings → Devices. The panel polls the QR via the internal HTTP API.
        return session.startQr(
          typeof payload.attemptId === 'string' ? payload.attemptId : undefined,
        )
      }
      case 'pause': {
        // Keep the session connected; only stop writing inbound to the inbox.
        session.setIngestPaused(true)
        await repo.setIngestPaused(channel.id, true)
        return { paused: true }
      }
      case 'resume': {
        session.setIngestPaused(false)
        await repo.setIngestPaused(channel.id, false)
        return { paused: false }
      }
      case 'send_code': {
        return session.submitCode(String(payload.code ?? ''))
      }
      case 'send_password': {
        return session.submitPassword(String(payload.password ?? ''))
      }
      case 'send_message': {
        const target = String(payload.target ?? '')
        const body = String(payload.body ?? '')
        // Optional Telegram reply target (the provider/Telegram message id of the
        // message being replied to).
        const replyToMsgId = payload.replyToProviderId
          ? Number(payload.replyToProviderId)
          : undefined
        const dbMessageId = payload.messageId
          ? String(payload.messageId)
          : null
        try {
          const result = await session.sendMessage(
            target,
            body,
            replyToMsgId ? { replyToMsgId } : undefined,
          )
          // Backfill the provider/Telegram message id onto the panel's optimistic
          // outbound row so it can later be deleted / forwarded / reacted to AND
          // so delivery/read receipts can be matched back to it.
          if (dbMessageId && result?.providerMessageId) {
            await repo.setMessageProviderId(
              dbMessageId,
              result.providerMessageId,
            )
          }
          return { sent: true }
        } catch (err) {
          // Surface the failure on the message row so the panel shows a failed
          // tick WITH a human-readable reason (flood wait, blocked, privacy…)
          // instead of a silent "sent" that never arrived. Transport failures
          // (session was down) get the stable OFFLINE_SEND_REASON marker so the
          // post-reconnect recovery sweep knows this message is safe to resend.
          if (dbMessageId) {
            const reason = isConnectionSendFailure(err)
              ? OFFLINE_SEND_REASON
              : telegramSendFailureReason(err)
            await repo
              .setMessageStatus(dbMessageId, 'failed', reason)
              .catch(() => {})
          }
          throw err
        }
      }
      case 'mark_read': {
        const target = String(payload.target ?? '')
        if (!target) throw new Error('mark_read requires target')
        // Best-effort: read receipts are a nicety, so a transient peer-resolution
        // miss must not surface as a failed job. Swallow and report not-read.
        try {
          await session.markRead(target)
          return { read: true }
        } catch (err) {
          logger.warn(
            { err, channelId: channel.id },
            'mark_read failed (non-fatal)',
          )
          return {
            read: false,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }
      case 'set_typing': {
        const target = String(payload.target ?? '')
        if (!target) throw new Error('set_typing requires target')
        // Typing indicators are purely cosmetic and Telegram expires them
        // quickly, so a failure here must never surface as a failed job.
        try {
          await session.setTyping(target)
          return { typing: true }
        } catch (err) {
          logger.warn(
            { err, channelId: channel.id },
            'set_typing failed (non-fatal)',
          )
          return { typing: false }
        }
      }
      case 'react_message': {
        const target = String(payload.target ?? '')
        const providerMessageId = Number(payload.providerMessageId ?? 0)
        if (!target || !providerMessageId) {
          throw new Error('react_message requires target and providerMessageId')
        }
        await session.reactToMessage(
          target,
          providerMessageId,
          String(payload.emoji ?? ''),
        )
        return { reacted: true }
      }
      case 'delete_message': {
        const target = String(payload.target ?? '')
        const providerMessageId = Number(payload.providerMessageId ?? 0)
        if (!target || !providerMessageId) {
          throw new Error('delete_message requires target and providerMessageId')
        }
        await session.deleteMessage(target, providerMessageId, true)
        return { deleted: true }
      }
      case 'edit_message': {
        const target = String(payload.target ?? '')
        const providerMessageId = Number(payload.providerMessageId ?? 0)
        const body = String(payload.body ?? '')
        if (!target || !providerMessageId || !body) {
          throw new Error(
            'edit_message requires target, providerMessageId and body',
          )
        }
        await session.editMessage(target, providerMessageId, body)
        return { edited: true }
      }
      case 'forward_message': {
        const fromTarget = String(payload.fromTarget ?? '')
        const toTarget = String(payload.toTarget ?? '')
        const providerMessageId = Number(payload.providerMessageId ?? 0)
        if (!fromTarget || !toTarget || !providerMessageId) {
          throw new Error(
            'forward_message requires fromTarget, toTarget and providerMessageId',
          )
        }
        const result = await session.forwardMessage(
          fromTarget,
          providerMessageId,
          toTarget,
        )
        const dbMessageId = payload.messageId ? String(payload.messageId) : null
        if (dbMessageId && result?.providerMessageId) {
          await repo.setMessageProviderId(dbMessageId, result.providerMessageId)
        }
        return { forwarded: true }
      }
      case 'send_sticker': {
        const target = String(payload.target ?? '')
        await session.sendSticker(target, {
          id: String(payload.documentId ?? ''),
          accessHash: String(payload.accessHash ?? ''),
          fileReference: String(payload.fileReference ?? ''),
        })
        return { sent: true }
      }
      case 'restart': {
        await session.stop()
        return session.start(channel.phone || undefined)
      }
      case 'stop': {
        await session.stop()
        return { stopped: true }
      }
      case 'logout': {
        await session.logout()
        this.sessions.delete(channel.id)
        return { loggedOut: true }
      }
      case 'kick_foreign_sessions': {
        // Manual God-panel trigger: runs the same enforcement logic as the
        // periodic sweep, but unconditionally (ignores the exclusive-session
        // toggle). Returns counts so the action result is informative.
        const kicked = await session.kickForeignSessionsNow()
        return { kicked }
      }
      default:
        throw new Error(`Unknown action: ${job.action}`)
    }
  }

  /**
   * On startup, resume Telegram sessions that were online/offline before the
   * restart.
   *
   * Sessions are started with a STAGGERED delay (plus jitter) rather than all at
   * once. A simultaneous burst of reconnects after a worker restart looks like
   * coordinated bot activity to Telegram and can get accounts flagged — spacing
   * them out keeps each account's behaviour independent and human-like. Accounts
   * in a cooled-down state (`rate_limited`, `error`, `logged_out`) are
   * intentionally NOT auto-resumed here (see listLiveChannels).
   */
  async restore(): Promise<void> {
    const channels = await repo.listLiveChannels()
    logger.info({ count: channels.length }, 'Restoring live sessions (staggered)')
    const STAGGER_MS = 4_000
    channels.forEach((channel, i) => {
      // Idempotency on boot: if drainQueue already (re)started this channel via
      // a queued start/restart job, a session is already registered for it.
      if (this.sessions.has(channel.id)) return
      const delay = i * STAGGER_MS + Math.floor(Math.random() * STAGGER_MS)
      setTimeout(() => {
        // Re-check at fire time: a job processed during the stagger window may
        // have created the session in the meantime.
        if (this.sessions.has(channel.id)) return
        try {
          const session = this.ensure(channel)
          // Preserve the soft-pause state across worker restarts.
          session.setIngestPaused(Boolean(channel.ingest_paused))
          void session.start(channel.phone || undefined)
        } catch (err) {
          logger.error(
            { err, channelId: channel.id },
            'Failed to restore session',
          )
        }
      }, delay)
    })
  }

  async shutdownAll(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.values()].map((s) => s.stop()),
    )
    this.sessions.clear()
  }
}

export const registry = new Registry()
