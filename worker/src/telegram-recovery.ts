import { Api, TelegramClient } from 'telegram'
import { logger } from './logger.js'
import * as repo from './repo.js'
import {
  isConnectionSendFailure,
  OFFLINE_SEND_REASON,
  telegramSendFailureReason,
} from './telegram-errors.js'

/** What the recovery sweep needs from the owning session — nothing more. */
export interface TelegramRecoveryDeps {
  channelId: string
  getClient: () => TelegramClient | null
  resolveTarget: (target: string) => Promise<Api.TypeInputPeer | string>
  sendMessage: (
    target: string,
    body: string,
  ) => Promise<{ providerMessageId?: string | null }>
}

/**
 * Post-reconnect delivery recovery. Managers keep typing while an account is
 * down; those sends fail at the transport level and used to silently never
 * arrive. This sweep finds outbound rows with no provider id that failed with
 * the OFFLINE marker (or whose send job was lost), resends them in original
 * order through the normal pacing throttle, and backfills provider ids /
 * statuses — so the thread shows the truth: delivered after reconnect, or a
 * failed tick with the real reason.
 */
export async function recoverUndeliveredOutbound(
  deps: TelegramRecoveryDeps,
): Promise<void> {
  try {
    const pending = await repo.listRecoverableOutbound(
      deps.channelId,
      OFFLINE_SEND_REASON,
    )
    if (pending.length === 0) return
    logger.info(
      { channelId: deps.channelId, count: pending.length },
      'TG delivery recovery: resending messages written while offline',
    )
    // Duplicate guard: a send that failed with "TIMEOUT" may still have
    // reached Telegram (the server can accept the RPC after the socket died),
    // so blindly resending would deliver the message TWICE. Before resending,
    // check the chat's recent outbound messages: if a message with identical
    // text already exists there, backfill its id and mark it sent instead of
    // sending again. One fetch per contact, cached.
    const recentOutByHandle = new Map<string, Map<string, string>>()
    const recentOutbound = async (
      handle: string,
    ): Promise<Map<string, string>> => {
      const cached = recentOutByHandle.get(handle)
      if (cached) return cached
      const byBody = new Map<string, string>()
      try {
        const entity = await deps.resolveTarget(handle)
        const recent = await deps.getClient()?.getMessages(entity, { limit: 20 })
        for (const m of recent ?? []) {
          if (m?.out && m.message) byBody.set(m.message, String(m.id))
        }
      } catch {
        /* best-effort: on failure we fall back to a normal resend */
      }
      recentOutByHandle.set(handle, byBody)
      return byBody
    }

    for (const msg of pending) {
      if (!deps.getClient()) return // disconnected mid-sweep — next login retries
      try {
        const already = (await recentOutbound(msg.contactHandle)).get(msg.body)
        if (already) {
          // It DID arrive before the disconnect — record the truth, no dupe.
          await repo.setMessageProviderId(msg.id, already).catch(() => {})
          await repo.setMessageStatus(msg.id, 'sent', null).catch(() => {})
          continue
        }
        const result = await deps.sendMessage(msg.contactHandle, msg.body)
        if (result.providerMessageId) {
          await repo.setMessageProviderId(msg.id, result.providerMessageId)
        }
        await repo.setMessageStatus(msg.id, 'sent', null).catch(() => {})
      } catch (err) {
        // A real provider rejection now gets its true reason; a transport
        // error keeps the OFFLINE marker so the NEXT reconnect retries it.
        const reason = isConnectionSendFailure(err)
          ? OFFLINE_SEND_REASON
          : telegramSendFailureReason(err)
        await repo.setMessageStatus(msg.id, 'failed', reason).catch(() => {})
        logger.warn(
          { channelId: deps.channelId, messageId: msg.id, err },
          'TG delivery recovery: resend failed',
        )
      }
    }
  } catch (err) {
    logger.warn(
      { channelId: deps.channelId, err },
      'TG delivery recovery sweep failed (non-fatal)',
    )
  }
}
