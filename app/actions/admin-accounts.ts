'use server'

import { revalidatePath } from 'next/cache'
import { randomBytes } from 'crypto'
import { requireAdmin } from '@/lib/auth'
import {
  createChannel,
  deleteChannelById,
  enqueueJob,
  getChannelById,
  getMaxChannelById,
  getProxyById,
  getProxyDescriptorById,
  getProxyForChannel,
  getVkChannelById,
  getWhatsappAppConfig,
  mergeChannelConfigById,
  proxyTypeInUse,
  updateChannelProxy,
  updateChannelSessionById,
  updateChannelStatus,
} from '@/lib/data'
import { decrypt, encrypt } from '@/lib/crypto'
import { getMe, subscribeWebhook, unsubscribeWebhook } from '@/lib/max'
import { getPhoneNumber as getWhatsappPhoneNumber } from '@/lib/whatsapp-cloud'
import {
  addCallbackServer as addVkCallbackServer,
  checkTokenScopes as checkVkTokenScopes,
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
 *  1. A proxy is OPTIONAL — when omitted the account connects directly. This
 *     matters because some proxies can't tunnel Telegram MTProto/WebSocket, so
 *     a direct connection must always be possible as a fallback.
 *  2. When a proxy IS chosen it serves at most ONE account per type (different
 *     types may share).
 *  3. MTProto proxies are Telegram-only (they can't tunnel VK/MAX/WhatsApp HTTP).
 * Returns an error string, or null when the selection is valid to use.
 */
async function validateProxyForType(
  proxyId: string | null,
  type: ChannelType,
  excludeChannelId?: string,
): Promise<string | null> {
  // No proxy → direct connection. Always allowed.
  if (!proxyId) return null
  const proxy = await getProxyById(proxyId)
  if (!proxy) return 'Указанный прокси не найден.'
  if (proxy.kind === 'mtproto' && type !== 'telegram') {
    return 'MTProto-прокси подходит только для Telegram. Для VK/MAX/WhatsApp выберите socks5 или http прокси.'
  }
  // GramJS has no HTTP-CONNECT transport: an HTTP proxy passed to a Telegram
  // session used to be silently treated as SOCKS5 and hang the connection.
  if (proxy.kind === 'http' && type === 'telegram') {
    return 'HTTP-прокси не поддерживается Telegram (MTProto). Выберите SOCKS5 или MTProto-прокси.'
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
  const rawPhone = String(formData.get('phone') ?? '').trim()
  const managerId = String(formData.get('managerId') ?? '').trim()
  const proxyId = String(formData.get('proxyId') ?? '').trim() || null

  if (!managerId) return { ok: false, message: 'Выберите менеджера-владельца.' }
  // Normalize to strict E.164 BEFORE anything is persisted or queued: MTProto's
  // sendCode wants +<digits>; spaces/dashes/parens used to pass through as-is
  // and are a known cause of "код не приходит".
  const digits = rawPhone.replace(/[\s\-()]/g, '')
  if (!/^\+?[0-9]{7,15}$/.test(digits)) {
    return { ok: false, message: 'Введите корректный номер, например +14155550132.' }
  }
  const phone = digits.startsWith('+') ? digits : `+${digits}`
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

/**
 * Re-request the login code on an EXISTING channel. Recovers from an expired
 * code, a worker restart mid-login (phoneCodeHash lives only in worker memory),
 * or a wrong code — previously the only way out was deleting the channel and
 * starting over. Re-enqueues the same `start` job the initial connect uses.
 */
export async function adminResendTelegramCodeAction(
  channelId: string,
): Promise<AdminAccountResult> {
  await requireAdmin()
  const channel = await getChannelById(channelId)
  if (!channel || !channel.managerId || channel.type !== 'telegram') {
    return { ok: false, message: 'Аккаунт не найден.' }
  }
  if (!channel.phone) {
    return { ok: false, message: 'У аккаунта не указан номер телефона.' }
  }
  if (channel.sessionStatus === 'online') {
    return { ok: false, message: 'Аккаунт уже подключён.' }
  }
  const attemptId = globalThis.crypto.randomUUID()
  await updateChannelSessionById(channelId, {
    sessionStatus: 'starting',
    lastError: null,
  })
  await enqueueJob({
    channelId,
    managerId: channel.managerId,
    action: 'start',
    payload: { phone: channel.phone, attemptId },
  })
  return {
    ok: true,
    message: 'Запрашиваем новый код входа…',
    channelId,
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
 * Telegram is delegated to the worker restart path (adminRestartTelegram below).
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
