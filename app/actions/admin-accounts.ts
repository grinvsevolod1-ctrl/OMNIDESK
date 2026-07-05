'use server'

import { revalidatePath } from 'next/cache'
import { randomBytes } from 'crypto'
import { requireAdmin } from '@/lib/auth'
import {
  createChannel,
  deleteChannelById,
  enqueueJob,
  getChannelById,
  getProxyById,
  getProxyDescriptorById,
  getProxyForChannel,
  getVkChannelById,
  mergeChannelConfigById,
  proxyTypeInUse,
  updateChannelProxy,
  updateChannelSessionById,
} from '@/lib/data'
import { decrypt, encrypt } from '@/lib/crypto'
import { getMe, subscribeWebhook, unsubscribeWebhook } from '@/lib/max'
import {
  addCallbackServer as addVkCallbackServer,
  deleteCallbackServer as deleteVkCallbackServer,
  getConfirmationCode as getVkConfirmationCode,
  getGroup as getVkGroup,
  setCallbackSettings as setVkCallbackSettings,
} from '@/lib/vk'
import { resolveAppBaseUrl } from '@/lib/app-url'
import type { ChannelStatus, ChannelType, SessionStatus } from '@/lib/types'

export interface AdminAccountResult {
  ok: boolean
  message: string
  channelId?: string
  sessionStatus?: SessionStatus
}

export interface ChannelStatusSnapshot {
  sessionStatus: SessionStatus
  status: ChannelStatus
  lastError: string | null
  detail: string
  codeDelivery: 'app' | 'sms' | null
}

/**
 * Enforce the proxy allocation rules for a NEW/edited account:
 *  1. A proxy is REQUIRED for every account (all four types).
 *  2. A proxy serves at most ONE account per type (different types may share).
 *  3. MTProto proxies are Telegram-only (they can't tunnel VK/MAX/WhatsApp HTTP).
 * Returns an error string, or null when the proxy is valid to use.
 */
async function validateProxyForType(
  proxyId: string | null,
  type: ChannelType,
  excludeChannelId?: string,
): Promise<string | null> {
  if (!proxyId) return 'Выберите прокси — он обязателен для каждого аккаунта.'
  const proxy = await getProxyById(proxyId)
  if (!proxy) return 'Указанный прокси не найден.'
  if (proxy.kind === 'mtproto' && type !== 'telegram') {
    return 'MTProto-прокси подходит только для Telegram. Для VK/MAX/WhatsApp выберите socks5 или http прокси.'
  }
  if (await proxyTypeInUse(proxyId, type, excludeChannelId)) {
    return `Этот прокси уже используется другим аккаунтом «${type}». Одно прокси = один аккаунт каждого типа — выберите другой.`
  }
  return null
}

/* --------------------------- Telegram (MTProto) -------------------------- */

/**
 * Admin: create a Telegram account for a chosen manager and begin MTProto login.
 * Requires a manager owner + a mandatory proxy. The worker requests a login code
 * (session_status -> code_pending); the admin then submits the code / 2FA below.
 */
export async function adminConnectTelegramAction(
  formData: FormData,
): Promise<AdminAccountResult> {
  await requireAdmin()
  const name = String(formData.get('name') ?? '').trim() || 'Telegram account'
  const phone = String(formData.get('phone') ?? '').trim()
  const managerId = String(formData.get('managerId') ?? '').trim()
  const proxyId = String(formData.get('proxyId') ?? '').trim() || null

  if (!managerId) return { ok: false, message: 'Выберите менеджера-владельца.' }
  if (!/^\+?[0-9\s\-()]{7,}$/.test(phone)) {
    return { ok: false, message: 'Введите корректный номер, например +14155550132.' }
  }
  const proxyError = await validateProxyForType(proxyId, 'telegram')
  if (proxyError) return { ok: false, message: proxyError }

  const attemptId = globalThis.crypto.randomUUID()
  const channel = await createChannel({
    managerId,
    type: 'telegram',
    name,
    detail: phone,
    status: 'pending',
    sessionStatus: 'starting',
    phone,
    proxyId,
    config: {},
  })

  await enqueueJob({
    channelId: channel.id,
    managerId,
    action: 'start',
    payload: { phone, attemptId },
  })

  return {
    ok: true,
    message: 'Запрашиваем код входа…',
    channelId: channel.id,
    sessionStatus: 'starting',
  }
}

export async function adminSubmitTelegramCodeAction(
  channelId: string,
  code: string,
): Promise<AdminAccountResult> {
  await requireAdmin()
  const channel = await getChannelById(channelId)
  if (!channel || !channel.managerId) {
    return { ok: false, message: 'Аккаунт не найден.' }
  }
  await updateChannelSessionById(channelId, { sessionStatus: 'code_pending' })
  await enqueueJob({
    channelId,
    managerId: channel.managerId,
    action: 'send_code',
    payload: { code: code.trim() },
  })
  return { ok: true, message: 'Проверяем код…', channelId }
}

export async function adminSubmitTelegramPasswordAction(
  channelId: string,
  password: string,
): Promise<AdminAccountResult> {
  await requireAdmin()
  const channel = await getChannelById(channelId)
  if (!channel || !channel.managerId) {
    return { ok: false, message: 'Аккаунт не найден.' }
  }
  await enqueueJob({
    channelId,
    managerId: channel.managerId,
    action: 'send_password',
    payload: { password },
  })
  return { ok: true, message: 'Проверяем пароль…', channelId }
}

export async function adminGetChannelStatusAction(
  channelId: string,
): Promise<ChannelStatusSnapshot | null> {
  await requireAdmin()
  const channel = await getChannelById(channelId)
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

/* ------------------------------- MAX (Bot) ------------------------------- */

export async function adminConnectMaxAction(
  formData: FormData,
): Promise<AdminAccountResult> {
  await requireAdmin()
  const token = String(formData.get('token') ?? '').trim()
  const fallbackName = String(formData.get('name') ?? '').trim()
  const managerId = String(formData.get('managerId') ?? '').trim()
  const proxyId = String(formData.get('proxyId') ?? '').trim() || null

  if (!managerId) return { ok: false, message: 'Выберите менеджера-владельца.' }
  if (!token) return { ok: false, message: 'Вставьте токен бота MAX из @MasterBot.' }
  const proxyError = await validateProxyForType(proxyId, 'max')
  if (proxyError) return { ok: false, message: proxyError }
  const proxy = await getProxyDescriptorById(proxyId as string)

  // 1. Validate the token through the account's proxy.
  const me = await getMe(token, proxy)
  if (!me.ok) {
    return {
      ok: false,
      message:
        me.status === 401
          ? 'Токен недействителен. Проверьте его в @MasterBot и попробуйте снова.'
          : `Не удалось проверить токен MAX: ${me.error}`,
    }
  }

  const botName =
    fallbackName ||
    me.data.name ||
    me.data.first_name ||
    (me.data.username ? `@${me.data.username}` : 'MAX-бот')
  const detail = me.data.username ? `@${me.data.username}` : `id ${me.data.user_id}`

  const webhookSecret = randomBytes(24).toString('hex')
  const channel = await createChannel({
    managerId,
    type: 'max',
    name: botName,
    detail,
    status: 'connected',
    sessionStatus: 'online',
    proxyId,
    config: {
      token: encrypt(token),
      webhookSecret: encrypt(webhookSecret),
      botUserId: me.data.user_id,
      username: me.data.username ?? null,
    },
  })

  let webhookUrl: string
  try {
    const base = await resolveAppBaseUrl()
    webhookUrl = `${base}/api/max/webhook/${channel.id}`
  } catch (err) {
    await deleteChannelById(channel.id)
    return {
      ok: false,
      message:
        err instanceof Error ? err.message : 'Не удалось определить публичный URL.',
    }
  }

  const sub = await subscribeWebhook(
    token,
    webhookUrl,
    webhookSecret,
    undefined,
    proxy,
  )
  if (!sub.ok) {
    await deleteChannelById(channel.id)
    return {
      ok: false,
      message: `Бот проверен, но не удалось зарегистрировать вебхук: ${sub.error}.`,
    }
  }

  revalidatePath('/admin/accounts')
  return {
    ok: true,
    message: `MAX-бот «${botName}» подключён.`,
    channelId: channel.id,
    sessionStatus: 'online',
  }
}

/* ------------------------------- VK (Community) -------------------------- */

export async function adminConnectVkAction(
  formData: FormData,
): Promise<AdminAccountResult> {
  await requireAdmin()
  const token = String(formData.get('token') ?? '').trim()
  const fallbackName = String(formData.get('name') ?? '').trim()
  const managerId = String(formData.get('managerId') ?? '').trim()
  const proxyId = String(formData.get('proxyId') ?? '').trim() || null

  if (!managerId) return { ok: false, message: 'Выберите менеджера-владельца.' }
  if (!token) return { ok: false, message: 'Вставьте токен доступа сообщества VK.' }
  const proxyError = await validateProxyForType(proxyId, 'vk')
  if (proxyError) return { ok: false, message: proxyError }
  const proxy = await getProxyDescriptorById(proxyId as string)

  const group = await getVkGroup(token, proxy)
  if (!group.ok) {
    return {
      ok: false,
      message: `Не удалось проверить токен VK: ${group.error}. Нужен ключ сообщества со scope «Сообщения» и «Управление».`,
    }
  }
  const groupId = group.data.id

  const confirmation = await getVkConfirmationCode(token, groupId, proxy)
  if (!confirmation.ok) {
    return {
      ok: false,
      message: `Токен принят, но не удалось получить код подтверждения Callback API: ${confirmation.error}.`,
    }
  }

  const name =
    fallbackName ||
    group.data.name ||
    (group.data.screen_name ? `@${group.data.screen_name}` : 'VK-сообщество')
  const detail = group.data.screen_name
    ? `@${group.data.screen_name}`
    : `club${groupId}`

  const webhookSecret = randomBytes(24).toString('hex')
  const channel = await createChannel({
    managerId,
    type: 'vk',
    name,
    detail,
    status: 'connected',
    sessionStatus: 'online',
    proxyId,
    config: {
      token: encrypt(token),
      webhookSecret: encrypt(webhookSecret),
      confirmationCode: confirmation.data,
      groupId,
      screenName: group.data.screen_name ?? null,
    },
  })

  let webhookUrl: string
  try {
    const base = await resolveAppBaseUrl()
    webhookUrl = `${base}/api/vk/webhook/${channel.id}`
  } catch (err) {
    await deleteChannelById(channel.id)
    return {
      ok: false,
      message:
        err instanceof Error ? err.message : 'Не удалось определить публичный URL.',
    }
  }

  const server = await addVkCallbackServer(
    token,
    groupId,
    webhookUrl,
    webhookSecret,
    proxy,
  )
  if (!server.ok) {
    await deleteChannelById(channel.id)
    return {
      ok: false,
      message: `Сообщество проверено, но не удалось зарегистрировать Callback-сервер: ${server.error}.`,
    }
  }

  const settings = await setVkCallbackSettings(
    token,
    groupId,
    server.data.server_id,
    proxy,
  )
  if (!settings.ok) {
    await deleteVkCallbackServer(
      token,
      groupId,
      server.data.server_id,
      proxy,
    ).catch(() => {})
    await deleteChannelById(channel.id)
    return {
      ok: false,
      message: `Не удалось включить события сообщений в VK: ${settings.error}.`,
    }
  }

  await mergeChannelConfigById(channel.id, { serverId: server.data.server_id })

  revalidatePath('/admin/accounts')
  return {
    ok: true,
    message: `VK-сообщество «${name}» подключено.`,
    channelId: channel.id,
    sessionStatus: 'online',
  }
}

/* ------------------------------ Management ------------------------------- */

/** Admin: reassign the proxy of an existing account (uniqueness enforced). */
export async function adminReassignProxyAction(
  channelId: string,
  proxyId: string,
): Promise<AdminAccountResult> {
  await requireAdmin()
  const channel = await getChannelById(channelId)
  if (!channel) return { ok: false, message: 'Аккаунт не найден.' }
  const proxyError = await validateProxyForType(proxyId, channel.type, channelId)
  if (proxyError) return { ok: false, message: proxyError }
  await updateChannelProxy(channelId, proxyId)
  revalidatePath('/admin/accounts')
  return { ok: true, message: 'Прокси переназначен.' }
}

/** Admin: delete any account, tearing down its live session / webhook first. */
export async function adminDeleteChannelAction(
  channelId: string,
): Promise<AdminAccountResult> {
  await requireAdmin()
  const channel = await getChannelById(channelId)
  if (!channel) return { ok: false, message: 'Аккаунт не найден.' }
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
      try {
        const base = await resolveAppBaseUrl()
        await unsubscribeWebhook(
          decrypt(cfg.token),
          `${base}/api/max/webhook/${channelId}`,
          proxy,
        )
      } catch (err) {
        console.error('[admin] failed to unsubscribe MAX webhook:', err)
      }
    }
  }
  if (channel.type === 'vk') {
    const vk = await getVkChannelById(channelId)
    if (vk && vk.serverId != null) {
      try {
        await deleteVkCallbackServer(vk.token, vk.groupId, vk.serverId, proxy)
      } catch (err) {
        console.error('[admin] failed to delete VK callback server:', err)
      }
    }
  }

  await deleteChannelById(channelId)
  revalidatePath('/admin/accounts')
  return { ok: true, message: 'Аккаунт удалён.' }
}
