import { logger } from './logger.js'
import { TelegramSession, telegramSendFailureReason } from './telegram.js'
import {
  isConnectionSendFailure,
  OFFLINE_SEND_REASON,
} from './telegram-errors.js'
import * as repo from './repo.js'
import { runSerialized } from './serialize.js'

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
 * Shown as the failed-tick reason when an outbound message targets a
 * god-created dialog whose contact was blocked from the god messenger. Mimics
 * "the other side blocked you" without ever touching Telegram.
 */
const SYNTHETIC_BLOCKED_REASON = 'Вы заблокированы получателем'

/**
 * God-created ("synthetic") dialogs address people who never messaged the
 * account first, so Telegram has no cached access_hash and a real send throws
 * "Could not find the input entity". Per the owner's design these threads must
 * behave as real, self-contained conversations: settle the outbound row locally
 * instead of dispatching to Telegram — delivered normally, or failed (blocked)
 * when the operator pressed "Заблокировать". Returns true when the send was
 * handled synthetically and the caller must skip the real send.
 *
 * This ONLY governs send simulation — never visibility/analytics (AGENTS §4.3).
 */
async function settleSyntheticSend(
  channelId: string,
  target: string,
  dbMessageId: string | null,
): Promise<boolean> {
  if (!target) return false
  const syn = await repo.getSyntheticDelivery(channelId, target)
  if (!syn.synthetic) return false
  if (dbMessageId) {
    await repo
      .setMessageStatus(
        dbMessageId,
        syn.blocked ? 'failed' : 'delivered',
        syn.blocked ? SYNTHETIC_BLOCKED_REASON : null,
      )
      .catch(() => {})
  }
  return true
}

/**
 * Holds every live session keyed by channelId and routes job actions to the
 * right session. Survives for the lifetime of the worker process.
 */
class Registry {
  private sessions = new Map<string, AnySession>()

  private ensure(channel: repo.ChannelRecord): AnySession {
    let s = this.sessions.get(channel.id)
    if (s) return s
    s = new TelegramSession(channel.id, channel.manager_id, {
      personal: channel.type === 'telegram_personal',
    })
    this.sessions.set(channel.id, s)
    return s
  }

  get(channelId: string): AnySession | undefined {
    return this.sessions.get(channelId)
  }

  /**
   * Reconnect adapter for the revival sweep: (re)create the session object and
   * start it with the saved session string. Mirrors what restore() does for a
   * single channel, preserving the soft-pause flag.
   *
   * Serialized through the same per-channel chain as queued jobs: without this
   * a revival start() could run concurrently with a send/login job that is
   * mid-flight on the SAME MTProto session (listRevivableChannels only
   * excludes start-type jobs, not sends), disconnecting the client under it.
   */
  async revive(
    channel: repo.ChannelRecord,
  ): Promise<{ sessionStatus: repo.SessionStatus }> {
    return runSerialized(channel.id, () => {
      const session = this.ensure(channel)
      session.setIngestPaused(Boolean(channel.ingest_paused))
      return session.start(channel.phone || undefined)
    })
  }

  /**
   * True for channels this worker is responsible for. Only Telegram runs here;
   * everything else (WhatsApp Cloud, VK, MAX, livechat) is owned by Next.js.
   */
  private isWorkerManaged(channel: repo.ChannelRecord): boolean {
    return channel.type === 'telegram' || channel.type === 'telegram_personal'
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

    // Личные аккаунты (god-панель) управляются джобами ТОЛЬКО в части
    // логина/жизненного цикла. Вся переписка идёт живьём через HTTP
    // /personal/* — messaging-джоб для такого канала быть не должно, а если
    // stale-джоба всё же пришла, это безопасный no-op, не крэш.
    if (channel.type === 'telegram_personal') {
      const allowed = new Set([
        'start',
        'start_qr',
        'send_code',
        'send_password',
        'restart',
        'stop',
        'logout',
      ])
      if (!allowed.has(job.action)) {
        logger.warn(
          { channelId: channel.id, action: job.action },
          'Ignoring non-lifecycle job for personal Telegram account',
        )
        return { skipped: `personal account: ${job.action} not allowed` }
      }
    }

    // Carry the persisted soft-pause flag into the (possibly freshly created)
    // session so a paused channel that reconnects/restarts stays paused.
    session.setIngestPaused(Boolean(channel.ingest_paused))

    switch (job.action) {
      case 'start': {
        // An explicit start supersedes any earlier manual stop.
        await repo.setManuallyStopped(channel.id, false)
        return session.start(
          (payload.phone as string) || channel.phone || undefined,
          typeof payload.attemptId === 'string' ? payload.attemptId : undefined,
        )
      }
      case 'start_qr': {
        // One-button QR login: no phone/SMS, the owner scans from Telegram →
        // Settings → Devices. The panel polls the QR via the internal HTTP API.
        await repo.setManuallyStopped(channel.id, false)
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
        // Optional server-side scheduling (unix seconds): Telegram delivers at
        // that time on its own — no worker timer involved.
        const scheduleAt = payload.scheduleAt
          ? Number(payload.scheduleAt)
          : undefined
        const dbMessageId = payload.messageId
          ? String(payload.messageId)
          : null
        // God-created dialog: settle locally, never touch Telegram.
        if (await settleSyntheticSend(channel.id, target, dbMessageId)) {
          return { sent: true }
        }
        try {
          const result = await session.sendMessage(
            target,
            body,
            replyToMsgId || scheduleAt
              ? { replyToMsgId, scheduleAt }
              : undefined,
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
      case 'send_voice': {
        // Voice note recorded in the panel composer. The audio arrives as
        // base64 in the payload (small: capped panel-side at ~1 MB /
        // ~60s of opus) and is delivered as a native Telegram voice bubble.
        const target = String(payload.target ?? '')
        const audioB64 = String(payload.audio ?? '')
        const durationSec = Number(payload.durationSec ?? 0)
        const dbMessageId = payload.messageId
          ? String(payload.messageId)
          : null
        if (!target || !audioB64) {
          throw new Error('send_voice requires target and audio')
        }
        // God-created dialog: settle locally, never touch Telegram.
        if (await settleSyntheticSend(channel.id, target, dbMessageId)) {
          return { sent: true }
        }
        try {
          const result = await session.sendVoice(target, {
            buffer: Buffer.from(audioB64, 'base64'),
            durationSec,
          })
          if (dbMessageId && result?.providerMessageId) {
            await repo.setMessageProviderId(
              dbMessageId,
              result.providerMessageId,
            )
          }
          return { sent: true }
        } catch (err) {
          // Same failure surfacing as text sends — the panel shows a failed
          // tick with a human-readable reason. Voice notes are intentionally
          // NOT auto-resent by the delivery-recovery sweep (media excluded).
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
      case 'send_file': {
        // Photo/document sent from the panel composer. The file arrives as
        // base64 in the payload (capped panel-side); a multi-photo batch
        // enqueues one send_file job per file, so ordering is preserved by
        // the sequential job queue. `asPhoto` renders an inline image bubble,
        // otherwise a document. Only the first file of a batch carries the
        // caption (Telegram album semantics).
        const target = String(payload.target ?? '')
        const fileB64 = String(payload.file ?? '')
        const name = payload.name ? String(payload.name) : 'file'
        const mime = payload.mime ? String(payload.mime) : undefined
        const asPhoto = Boolean(payload.asPhoto)
        const caption = payload.caption ? String(payload.caption) : undefined
        const replyToProviderId = payload.replyToProviderId
          ? Number(payload.replyToProviderId)
          : undefined
        const dbMessageId = payload.messageId
          ? String(payload.messageId)
          : null
        if (!target || !fileB64) {
          throw new Error('send_file requires target and file')
        }
        // God-created dialog: settle locally, never touch Telegram.
        if (await settleSyntheticSend(channel.id, target, dbMessageId)) {
          return { sent: true }
        }
        try {
          const result = await session.personalSendFile(target, {
            buffer: Buffer.from(fileB64, 'base64'),
            name,
            mime: mime ?? null,
            asPhoto,
            caption,
            replyToMsgId: replyToProviderId,
          })
          if (dbMessageId && result?.providerMessageId) {
            await repo.setMessageProviderId(
              dbMessageId,
              result.providerMessageId,
            )
          }
          return { sent: true }
        } catch (err) {
          // Same failure surfacing as text/voice sends. Media is intentionally
          // NOT auto-resent by the delivery-recovery sweep.
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
        await repo.setManuallyStopped(channel.id, false)
        await session.stop()
        return session.start(channel.phone || undefined)
      }
      case 'stop': {
        // Record the intent BEFORE stopping: without this flag the revival
        // sweep sees "offline + saved session" and resurrects the account
        // ~60 seconds after the admin deliberately stopped it.
        await repo.setManuallyStopped(channel.id, true)
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
        // Serialized with queued jobs for the same channel (see revive()).
        void runSerialized(channel.id, () => {
          if (this.sessions.has(channel.id)) return Promise.resolve()
          const session = this.ensure(channel)
          // Preserve the soft-pause state across worker restarts.
          session.setIngestPaused(Boolean(channel.ingest_paused))
          return session.start(channel.phone || undefined).then(() => undefined)
        }).catch((err) => {
          logger.error(
            { err, channelId: channel.id },
            'Failed to restore session',
          )
        })
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
