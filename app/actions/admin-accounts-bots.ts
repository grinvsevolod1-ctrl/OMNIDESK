'use server'

import { revalidatePath } from 'next/cache'
import { randomBytes } from 'crypto'
import { requireAdmin } from '@/lib/auth'
import {
  createChannel,
  deleteChannelById,
  getProxyDescriptorById,
  mergeChannelConfigById,
} from '@/lib/data'
import { encrypt } from '@/lib/crypto'
import { getMe, subscribeWebhook } from '@/lib/max'
import {
  addCallbackServer as addVkCallbackServer,
  checkTokenScopes as checkVkTokenScopes,
  deleteCallbackServer as deleteVkCallbackServer,
  getConfirmationCode as getVkConfirmationCode,
  getGroup as getVkGroup,
  setCallbackSettings as setVkCallbackSettings,
} from '@/lib/vk'
import { resolveAppBaseUrl } from '@/lib/app-url'
import {
  validateProxyForType,
  type AdminAccountResult,
} from './admin-accounts-shared'

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

  // 1. Validate the token — strip any accidental whitespace/newlines from
  // copy-paste before sending, then call /me to confirm it's real.
  const cleanToken = token.replace(/[\r\n\t]/g, '').trim()
  const me = await getMe(cleanToken, proxy)
  if (!me.ok) {
    return {
      ok: false,
      // Always show the real error from MAX (status + message) so it's clear
      // whether it's a bad token, a network issue, or something else entirely.
      message: `Ошибка MAX API (${me.status ?? 'нет ответа'}): ${me.error}`,
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
      token: encrypt(cleanToken),
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

  // Verify the token actually has the required scopes before wiring up the
  // callback server — otherwise the admin gets a confusing failure mid-setup.
  const scopes = await checkVkTokenScopes(token, proxy)
  if (!scopes.ok) {
    return {
      ok: false,
      message: `Не удалось проверить права токена VK: ${scopes.error}.`,
    }
  }
  if (scopes.data.missing.length > 0) {
    const labels: Record<string, string> = {
      messages: '«Сообщения»',
      manage: '«Управление сообществом»',
    }
    const names = scopes.data.missing.map((s) => labels[s] ?? s).join(', ')
    return {
      ok: false,
      message: `У токена не хватает прав: ${names}. Создайте ключ доступа сообщества с этими scope и вставьте заново.`,
    }
  }

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
