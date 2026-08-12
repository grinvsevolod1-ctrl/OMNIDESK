'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  deleteChannelById,
  enqueueJob,
  getChannelById,
  getMaxChannelById,
  getProxyForChannel,
  getVkChannelById,
  getWhatsappAppConfig,
  updateChannelProxy,
  updateChannelSessionById,
  updateChannelStatus,
} from '@/lib/data'
import { decrypt } from '@/lib/crypto'
import { getMe, unsubscribeWebhook } from '@/lib/max'
import { getPhoneNumber as getWhatsappPhoneNumber } from '@/lib/whatsapp-cloud'
import {
  checkTokenScopes as checkVkTokenScopes,
  deleteCallbackServer as deleteVkCallbackServer,
  getGroup as getVkGroup,
} from '@/lib/vk'
import { resolveAppBaseUrl } from '@/lib/app-url'
import {
  validateProxyForType,
  type AdminAccountResult,
} from './admin-accounts-shared'

/* ------------------------------ Health check ----------------------------- */

/**
 * Admin: actively re-verify a webhook-based account (VK / MAX / WhatsApp Cloud)
 * by calling the provider through the account's proxy. Unlike Telegram (which
 * runs a live socket the worker can restart), these channels are "always online"
 * as long as their token + webhook are valid — so a health check IS their
 * reconnect: it proves the token still works and updates session_status +
 * last_error so any breakage (revoked token, missing scope, wrong phone id) is
 * immediately visible in the panel instead of silently failing on next send.
 *
 * Telegram is delegated to the worker restart path.
 */
export async function adminHealthCheckAction(
  channelId: string,
): Promise<AdminAccountResult> {
  await requireAdmin()
  const channel = await getChannelById(channelId)
  if (!channel) return { ok: false, message: 'Аккаунт не найден.' }

  // Telegram: reconnect via the worker (reuses the stored session, no code).
  if (channel.type === 'telegram') {
    if (!channel.managerId) {
      return { ok: false, message: 'У аккаунта нет владельца.' }
    }
    await updateChannelSessionById(channelId, { sessionStatus: 'starting' })
    await enqueueJob({
      channelId,
      managerId: channel.managerId,
      action: 'restart',
    })
    revalidatePath('/admin/accounts')
    return { ok: true, message: 'Переподключаем Telegram…', channelId }
  }

  const proxy = await getProxyForChannel(channelId)

  // Helper: persist the check outcome (status + error) and revalidate.
  async function persist(ok: boolean, error: string | null) {
    await updateChannelSessionById(channelId, {
      sessionStatus: ok ? 'online' : 'error',
      lastError: error,
    })
    if (channel!.managerId) {
      await updateChannelStatus(
        channelId,
        channel!.managerId,
        ok ? 'connected' : 'error',
      )
    }
    revalidatePath('/admin/accounts')
  }

  if (channel.type === 'vk') {
    const vk = await getVkChannelById(channelId)
    if (!vk) return { ok: false, message: 'VK-аккаунт не найден.' }
    const group = await getVkGroup(vk.token, proxy)
    if (!group.ok) {
      await persist(false, `VK: ${group.error}`)
      return { ok: false, message: `VK недоступен: ${group.error}`, channelId }
    }
    const scopes = await checkVkTokenScopes(vk.token, proxy)
    if (scopes.ok && scopes.data.missing.length > 0) {
      const msg = `VK: у токена не хватает прав (${scopes.data.missing.join(', ')}).`
      await persist(false, msg)
      return { ok: false, message: msg, channelId }
    }
    await persist(true, null)
    return { ok: true, message: 'VK на связи — токен действителен.', channelId }
  }

  if (channel.type === 'max') {
    const max = await getMaxChannelById(channelId)
    if (!max) return { ok: false, message: 'MAX-аккаунт не найден.' }
    const me = await getMe(max.token, proxy)
    if (!me.ok) {
      const msg =
        me.status === 401
          ? 'MAX: токен недействителен — переподключите аккаунт.'
          : `MAX недоступен: ${me.error}`
      await persist(false, msg)
      return { ok: false, message: msg, channelId }
    }
    await persist(true, null)
    return { ok: true, message: 'MAX на связи — токен действителен.', channelId }
  }

  if (channel.type === 'whatsapp') {
    const app = await getWhatsappAppConfig()
    if (!app) {
      await persist(false, 'WhatsApp: не задан токен приложения в админке.')
      return {
        ok: false,
        message: 'WhatsApp не настроен: добавьте токен на странице WhatsApp.',
        channelId,
      }
    }
    const phoneNumberId = (channel.config as { phoneNumberId?: string } | null)
      ?.phoneNumberId
    if (!phoneNumberId) {
      await persist(false, 'WhatsApp: у номера не задан phone number id.')
      return { ok: false, message: 'У номера не задан phone number id.', channelId }
    }
    const info = await getWhatsappPhoneNumber(phoneNumberId, app.accessToken)
    if (!info.ok) {
      await persist(false, `WhatsApp: ${info.error}`)
      return { ok: false, message: `WhatsApp недоступен: ${info.error}`, channelId }
    }
    await persist(true, null)
    return {
      ok: true,
      message: 'WhatsApp на связи — номер и токен действительны.',
      channelId,
    }
  }

  return { ok: false, message: 'Проверка недоступна для этого типа аккаунта.' }
}

/* ------------------------------ Management ------------------------------- */

/** Admin: reassign the proxy of an existing account (uniqueness enforced). */
export async function adminReassignProxyAction(
  channelId: string,
  proxyId: string | null,
): Promise<AdminAccountResult> {
  await requireAdmin()
  const channel = await getChannelById(channelId)
  if (!channel) return { ok: false, message: 'Аккаунт не найден.' }
  // Empty selection → detach the proxy (direct connection).
  const nextProxyId = proxyId && proxyId.trim() ? proxyId.trim() : null
  const proxyError = await validateProxyForType(
    nextProxyId,
    channel.type,
    channelId,
  )
  if (proxyError) return { ok: false, message: proxyError }
  await updateChannelProxy(channelId, nextProxyId)
  revalidatePath('/admin/accounts')
  return {
    ok: true,
    message: nextProxyId
      ? 'Прокси переназначен.'
      : 'Прокси отключён — аккаунт подключается напрямую.',
  }
}

/** Admin: delete any account, tearing down its live session / webhook first. */
export async function adminDeleteChannelAction(
  channelId: string,
): Promise<AdminAccountResult> {
  await requireAdmin()
  const channel = await getChannelById(channelId)
  if (!channel) return { ok: false, message: 'Аккаунт не найден.' }

  // Best-effort remote teardown (stop live session, unsubscribe webhooks). NONE
  // of this must block the actual delete: if a proxy lookup, decrypt, or remote
  // API call fails, we still want the account gone from the panel. Any failure
  // here is logged and swallowed so we always reach deleteChannelById below.
  try {
    const proxy = await getProxyForChannel(channelId)

    if (channel.managerId && channel.type === 'telegram') {
      await enqueueJob({
        channelId,
        managerId: channel.managerId,
        action: 'stop',
      }).catch(() => {})
    }
    if (channel.type === 'max') {
      const cfg = channel.config as { token?: unknown }
      if (typeof cfg.token === 'string') {
        const base = await resolveAppBaseUrl()
        await unsubscribeWebhook(
          decrypt(cfg.token),
          `${base}/api/max/webhook/${channelId}`,
          proxy,
        )
      }
    }
    if (channel.type === 'vk') {
      const vk = await getVkChannelById(channelId)
      if (vk && vk.serverId != null) {
        await deleteVkCallbackServer(vk.token, vk.groupId, vk.serverId, proxy)
      }
    }
  } catch (err) {
    console.error('[admin] channel teardown failed, deleting anyway:', err)
  }

  // The actual delete. If THIS fails the account really can't be removed, so
  // surface a clear error instead of letting the exception escape to the client
  // (which would leave the confirm dialog stuck with no feedback).
  try {
    await deleteChannelById(channelId)
  } catch (err) {
    console.error('[admin] failed to delete channel:', err)
    return {
      ok: false,
      message: 'Не удалось удалить аккаунт. Попробуйте ещё раз.',
    }
  }

  revalidatePath('/admin/accounts')
  return { ok: true, message: 'Аккаунт удалён.' }
}
