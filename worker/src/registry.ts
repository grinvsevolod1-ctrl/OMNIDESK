import { logger } from './logger.js'
import { TelegramSession } from './telegram.js'
import { WhatsAppSession } from './whatsapp.js'
import * as repo from './repo.js'

type AnySession = TelegramSession | WhatsAppSession

/**
 * Holds every live session keyed by channelId and routes job actions to the
 * right session. Survives for the lifetime of the worker process.
 */
class Registry {
  private sessions = new Map<string, AnySession>()

  private ensure(channel: repo.ChannelRecord): AnySession {
    let s = this.sessions.get(channel.id)
    if (s) return s
    s =
      channel.type === 'telegram'
        ? new TelegramSession(channel.id, channel.manager_id)
        : new WhatsAppSession(channel.id, channel.manager_id)
    this.sessions.set(channel.id, s)
    return s
  }

  get(channelId: string): AnySession | undefined {
    return this.sessions.get(channelId)
  }

  /** Latest WhatsApp QR data-url, if the channel is waiting for a scan. */
  getQr(channelId: string): string | null {
    const s = this.sessions.get(channelId)
    return s instanceof WhatsAppSession ? s.qrDataUrl : null
  }

  /** Latest WhatsApp pairing code, if the channel is linking by phone number. */
  getPairingCode(channelId: string): string | null {
    const s = this.sessions.get(channelId)
    return s instanceof WhatsAppSession ? s.pairingCode : null
  }

  async handleJob(job: repo.JobRecord): Promise<Record<string, unknown>> {
    const channel = await repo.getChannel(job.channel_id)
    if (!channel) throw new Error('Channel not found')
    // Cloud API WhatsApp channels are handled entirely by the Next.js webhook;
    // the worker must never open a Baileys socket for them. Defensive no-op in
    // case a stale job slips through.
    if (channel.type === 'whatsapp' && channel.config?.provider === 'cloud') {
      return { skipped: 'cloud-managed channel' }
    }
    const session = this.ensure(channel)
    const payload = job.payload || {}

    // Carry the persisted soft-pause flag into the (possibly freshly created)
    // session so a paused channel that reconnects/restarts stays paused.
    session.setIngestPaused(Boolean(channel.ingest_paused))

    switch (job.action) {
      case 'start':
      case 'request_qr': {
        if (session instanceof TelegramSession) {
          return session.start(
            (payload.phone as string) || channel.phone || undefined,
            typeof payload.attemptId === 'string' ? payload.attemptId : undefined,
          )
        }
        return session.start({
          phone: (payload.phone as string) || channel.phone || undefined,
        })
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
        if (session instanceof TelegramSession) {
          return session.submitCode(String(payload.code ?? ''))
        }
        throw new Error('send_code is only valid for Telegram')
      }
      case 'send_password': {
        if (session instanceof TelegramSession) {
          return session.submitPassword(String(payload.password ?? ''))
        }
        throw new Error('send_password is only valid for Telegram')
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
          // tick instead of a silent "sent" that never arrived (e.g. WA 463 /
          // number not on WhatsApp).
          if (dbMessageId) {
            await repo.setMessageStatus(dbMessageId, 'failed').catch(() => {})
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
      case 'react_message': {
        if (!(session instanceof TelegramSession)) {
          throw new Error('react_message is only valid for Telegram')
        }
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
        if (!(session instanceof TelegramSession)) {
          throw new Error('delete_message is only valid for Telegram')
        }
        const target = String(payload.target ?? '')
        const providerMessageId = Number(payload.providerMessageId ?? 0)
        if (!target || !providerMessageId) {
          throw new Error('delete_message requires target and providerMessageId')
        }
        await session.deleteMessage(target, providerMessageId, true)
        return { deleted: true }
      }
      case 'forward_message': {
        if (!(session instanceof TelegramSession)) {
          throw new Error('forward_message is only valid for Telegram')
        }
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
        if (!(session instanceof TelegramSession)) {
          throw new Error('send_sticker is only valid for Telegram')
        }
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
        if (session instanceof TelegramSession) {
          return session.start(channel.phone || undefined)
        }
        return session.start({ phone: channel.phone || undefined })
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
      default:
        throw new Error(`Unknown action: ${job.action}`)
    }
  }

  /**
   * On startup, resume sessions that were online/offline before restart.
   *
   * Sessions are started with a STAGGERED delay (plus jitter) rather than all at
   * once. A simultaneous burst of reconnects after a worker restart looks like
   * coordinated bot activity to WhatsApp/Telegram and can get accounts flagged
   * — especially dangerous because a single restart would otherwise hit every
   * account at the exact same instant. Spacing them out keeps each account's
   * behaviour independent and human-like. Accounts in a cooled-down state
   * (`rate_limited`, `error`, `logged_out`) are intentionally NOT auto-resumed
   * here (see listLiveChannels) so we never resume hammering a restricted one.
   */
  async restore(): Promise<void> {
    const channels = await repo.listLiveChannels()
    logger.info({ count: channels.length }, 'Restoring live sessions (staggered)')
    const STAGGER_MS = 4_000
    channels.forEach((channel, i) => {
      // Idempotency on boot: if drainQueue already (re)started this channel via
      // a queued start/restart job, a session is already registered for it.
      // Starting it again here would open a second socket for the same device
      // and trip a multi-device 401 — so skip channels we're already handling.
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
          if (session instanceof TelegramSession) {
            void session.start(channel.phone || undefined)
          } else {
            void session.start({ phone: channel.phone || undefined })
          }
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
