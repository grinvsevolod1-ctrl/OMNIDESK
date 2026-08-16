'use server'

import { revalidatePath } from 'next/cache'
import { requireManager } from '@/lib/auth'
import { enqueueJob, getChannel, listChannels } from '@/lib/data'
import type { ChannelStatus, SessionStatus } from '@/lib/types'

/**
 * Manager-facing channel actions.
 *
 * Account CREATION and LOGIN (Telegram code/2FA, VK/MAX token onboarding, and
 * deletion) now live exclusively with the admin — see
 * app/actions/admin-accounts.ts and /admin/accounts. Managers can only observe
 * their assigned accounts and re-establish a dropped session (a restart reuses
 * the stored session and needs no login code), which powers the inbox's
 * automatic reconnection.
 */

export interface ChannelResult {
  ok: boolean
  message: string
}

/* ----------------------------- Status polling ---------------------------- */

export interface ChannelStatusSnapshot {
  sessionStatus: SessionStatus
  status: ChannelStatus
  lastError: string | null
  detail: string
  /** Where Telegram delivered the login code: in-app message vs SMS. */
  codeDelivery: 'app' | 'sms' | null
}

export async function getChannelStatusAction(
  channelId: string,
): Promise<ChannelStatusSnapshot | null> {
  const session = await requireManager()
  const channel = await getChannel(channelId, session.sub)
  if (!channel) return null
  const delivery = (channel.config as { codeDelivery?: unknown } | null)
    ?.codeDelivery
  return {
    sessionStatus: channel.sessionStatus,
    status: channel.status,
    lastError: channel.lastError,
    detail: channel.detail,
    codeDelivery: delivery === 'app' || delivery === 'sms' ? delivery : null,
  }
}

/**
 * Batched variant: statuses for many channels in ONE round trip and ONE query.
 * Powers the shared connections-page poller — previously every ChannelCard
 * polled individually, so N accounts cost N parallel requests every 15s.
 * Scoped to the caller: only their own channels come back.
 */
export async function getChannelStatusesAction(
  channelIds: string[],
): Promise<Record<string, ChannelStatusSnapshot>> {
  const session = await requireManager()
  if (channelIds.length === 0) return {}
  const wanted = new Set(channelIds)
  const channels = await listChannels(session.sub)
  const out: Record<string, ChannelStatusSnapshot> = {}
  for (const channel of channels) {
    if (!wanted.has(channel.id)) continue
    const delivery = (channel.config as { codeDelivery?: unknown } | null)
      ?.codeDelivery
    out[channel.id] = {
      sessionStatus: channel.sessionStatus,
      status: channel.status,
      lastError: channel.lastError,
      detail: channel.detail,
      codeDelivery: delivery === 'app' || delivery === 'sms' ? delivery : null,
    }
  }
  return out
}

/* ------------------------------ Reconnect -------------------------------- */

/**
 * Re-establish a dropped personal session. The worker reconnects using the
 * stored session, so no login code is needed — this is the manager's only lever
 * and the primitive the inbox uses for automatic reconnection. Scoped to the
 * caller's own channel.
 */
export async function restartChannelAction(
  channelId: string,
): Promise<ChannelResult> {
  const session = await requireManager()
  const channel = await getChannel(channelId, session.sub)
  if (!channel) return { ok: false, message: 'Канал не найден.' }

  await enqueueJob({ channelId, managerId: session.sub, action: 'restart' })
  revalidatePath('/app/connections')
  return { ok: true, message: 'Переподключаем…' }
}
