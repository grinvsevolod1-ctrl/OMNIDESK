'use server'

import { revalidatePath } from 'next/cache'
import { requireManager } from '@/lib/auth'
import {
  createChannel,
  deleteChannel,
  enqueueJob,
  getChannel,
  getVkChannelById,
  mergeChannelConfig,
  updateChannelSession,
} from '@/lib/data'
import { fetchPairingCode, fetchQr } from '@/lib/worker-client'
import { authLog, describePhone, maskPhone } from '@/lib/auth-log'
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
import { randomBytes } from 'crypto'
import type { ChannelStatus, JobAction, SessionStatus } from '@/lib/types'

export interface ChannelResult {
  ok: boolean
  message: string
  apiKey?: string
}

export interface StartResult {
  ok: boolean
  message: string
  channelId?: string
  sessionStatus?: SessionStatus
}

/* --------------------------- Telegram (MTProto) -------------------------- */

/**
 * Create a Telegram channel and ask the worker to begin MTProto login by phone
 * number. The worker requests a code (session_status -> code_pending); the UI
 * then polls getChannelStatusAction and submits the code / 2FA password.
 */
export async function connectTelegramAction(
  formData: FormData,
): Promise<StartResult> {
  const session = await requireManager()
  const name = String(formData.get('name') ?? '').trim() || 'Telegram account'
  const rawPhone = String(formData.get('phone') ?? '')
  const phone = rawPhone.trim()
  const proxyId = (String(formData.get('proxyId') ?? '').trim() || null) as
    | string
    | null

  // Correlation id shared with the worker so the whole attempt (panel input ->
  // worker sendCode -> code submit) can be traced as one flow.
  const attemptId = globalThis.crypto.randomUUID()
  authLog('input', {
    attemptId,
    managerId: session.sub,
    hasProxy: Boolean(proxyId),
    rawPhone: maskPhone(rawPhone),
    trimmedDifferent: rawPhone !== phone,
    phone: describePhone(phone),
  })

  if (!/^\+?[0-9\s\-()]{7,}$/.test(phone)) {
    authLog('validation:rejected', {
      attemptId,
      reason: 'regex',
      phone: describePhone(phone),
    })
    return {
      ok: false,
      message: 'Enter a valid phone number, e.g. +14155550132.',
    }
  }

  const channel = await createChannel({
    managerId: session.sub,
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
    managerId: session.sub,
    action: 'start',
    payload: { phone, attemptId },
  })
  authLog('job:enqueued', {
    attemptId,
    channelId: channel.id,
    action: 'start',
    phoneSentToWorker: maskPhone(phone),
    note: 'phone is passed to MTProto exactly as stored (no E.164 reformatting in the panel)',
  })
  // NOTE: intentionally NOT calling revalidatePath here. Doing so refreshes the
  // connections page mid-flow, which can unmount the open wizard dialog (e.g.
  // the empty-state instance) and wipe the code-entry step. The list is
  // refreshed by the client once the dialog closes.
  return {
    ok: true,
    message: 'Requesting login code…',
    channelId: channel.id,
    sessionStatus: 'starting',
  }
}

export async function submitTelegramCodeAction(
  channelId: string,
  code: string,
): Promise<StartResult> {
  const session = await requireManager()
  authLog('code:submit', {
    channelId,
    managerId: session.sub,
    codeLength: code.trim().length,
  })
  await updateChannelSession(channelId, session.sub, {
    sessionStatus: 'code_pending',
  })
  await enqueueJob({
    channelId,
    managerId: session.sub,
    action: 'send_code',
    payload: { code: code.trim() },
  })
  return { ok: true, message: 'Verifying code…', channelId }
}

export async function submitTelegramPasswordAction(
  channelId: string,
  password: string,
): Promise<StartResult> {
  const session = await requireManager()
  authLog('password:submit', {
    channelId,
    managerId: session.sub,
    passwordLength: password.length,
  })
  await enqueueJob({
    channelId,
    managerId: session.sub,
    action: 'send_password',
    payload: { password },
  })
  return { ok: true, message: 'Verifying password…', channelId }
}

/* ------------------------- WhatsApp (Cloud API) -------------------------- */

// WhatsApp is now configured at the app level by the admin (see
// /admin/whatsapp): one Meta app (token + app secret + webhook) shared by every
// phone number, with numbers assigned to managers. The old per-manager connect
// flow has been removed — managers no longer enter Cloud API credentials here.

/** Fetch the live WhatsApp QR for a channel from the worker. */
export async function getQrAction(
  channelId: string,
): Promise<{ qr: string | null }> {
  await requireManager()
  const qr = await fetchQr(channelId)
  return { qr }
}

/** Fetch the live WhatsApp pairing code for a channel from the worker. */
export async function getPairingCodeAction(
  channelId: string,
): Promise<{ code: string | null }> {
  await requireManager()
  const code = await fetchPairingCode(channelId)
  return { code }
}

/* ------------------------------- MAX (Bot) ------------------------------- */

/**
 * Connect a MAX bot by its token (obtained from @MasterBot in MAX). Unlike
 * Telegram/WhatsApp this needs no worker session: we validate the token via
 * GET /me, persist the channel with the token + a random webhook secret
 * (both encrypted at rest), then register a webhook with botapi.max.ru pointed
 * at our /api/max/webhook/[channelId] route. Inbound then flows in exactly like
 * live-chat; outbound is sent directly with POST /messages.
 */
export async function connectMaxAction(
  formData: FormData,
): Promise<StartResult> {
  const session = await requireManager()
  const token = String(formData.get('token') ?? '').trim()
  const fallbackName = String(formData.get('name') ?? '').trim()

  if (!token) {
    return { ok: false, message: 'Вставьте токен бота MAX из @MasterBot.' }
  }

  // 1. Validate the token by fetching the bot identity.
  const me = await getMe(token)
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

  // 2. Persist the channel with encrypted secrets. A random per-channel secret
  //    lets the webhook verify the X-Max-Bot-Api-Secret header.
  const webhookSecret = randomBytes(24).toString('hex')
  const channel = await createChannel({
    managerId: session.sub,
    type: 'max',
    name: botName,
    detail,
    status: 'connected',
    sessionStatus: 'online',
    config: {
      token: encrypt(token),
      webhookSecret: encrypt(webhookSecret),
      botUserId: me.data.user_id,
      username: me.data.username ?? null,
    },
  })

  // 3. Register the webhook so MAX delivers updates to us.
  let webhookUrl: string
  try {
    const base = await resolveAppBaseUrl()
    webhookUrl = `${base}/api/max/webhook/${channel.id}`
  } catch (err) {
    await deleteChannel(channel.id, session.sub)
    return {
      ok: false,
      message:
        err instanceof Error
          ? err.message
          : 'Не удалось определить публичный URL приложения.',
    }
  }

  const sub = await subscribeWebhook(token, webhookUrl, webhookSecret)
  if (!sub.ok) {
    // Roll back the channel so the user isn't left with a half-connected bot.
    await deleteChannel(channel.id, session.sub)
    return {
      ok: false,
      message: `Бот проверен, но не удалось зарегистрировать вебхук: ${sub.error}. Убедитесь, что приложение доступно по HTTPS.`,
    }
  }

  revalidatePath('/app/connections')
  revalidatePath('/app')
  return {
    ok: true,
    message: `MAX-бот «${botName}» подключён.`,
    channelId: channel.id,
    sessionStatus: 'online',
  }
}

/* ------------------------------- VK (Community) -------------------------- */

/**
 * Connect a VK community by its access token (Settings → Work with API → Access
 * tokens, with the `messages` + `manage` scopes). Like MAX this needs no worker
 * session: we validate the token via groups.getById, persist the channel with
 * the token + a random Callback secret + the VK confirmation code (token and
 * secret encrypted at rest), then register a Callback API server pointed at our
 * /api/vk/webhook/[channelId] route and switch on the message_new event.
 * Inbound then flows in exactly like live-chat; outbound is sent directly via
 * messages.send.
 */
export async function connectVkAction(
  formData: FormData,
): Promise<StartResult> {
  const session = await requireManager()
  const token = String(formData.get('token') ?? '').trim()
  const fallbackName = String(formData.get('name') ?? '').trim()

  if (!token) {
    return {
      ok: false,
      message: 'Вставьте токен доступа сообщества VK.',
    }
  }

  // 1. Validate the token by resolving the community it belongs to.
  const group = await getVkGroup(token)
  if (!group.ok) {
    return {
      ok: false,
      message: `Не удалось проверить токен VK: ${group.error}. Нужен ключ доступа сообщества со scope «Сообщения» и «Управление».`,
    }
  }
  const groupId = group.data.id

  // 2. Fetch the confirmation string VK will expect our webhook to echo.
  const confirmation = await getVkConfirmationCode(token, groupId)
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

  // 3. Persist the channel with encrypted secrets. A random per-channel secret
  //    lets the webhook verify the `secret` field VK sends with each event.
  const webhookSecret = randomBytes(24).toString('hex')
  const channel = await createChannel({
    managerId: session.sub,
    type: 'vk',
    name,
    detail,
    status: 'connected',
    sessionStatus: 'online',
    config: {
      token: encrypt(token),
      webhookSecret: encrypt(webhookSecret),
      confirmationCode: confirmation.data,
      groupId,
      screenName: group.data.screen_name ?? null,
    },
  })

  // 4. Register the Callback API server (VK probes the URL immediately, so the
  //    channel — and thus the confirmation code — must already be persisted).
  let webhookUrl: string
  try {
    const base = await resolveAppBaseUrl()
    webhookUrl = `${base}/api/vk/webhook/${channel.id}`
  } catch (err) {
    await deleteChannel(channel.id, session.sub)
    return {
      ok: false,
      message:
        err instanceof Error
          ? err.message
          : 'Не удалось определить публичный URL приложения.',
    }
  }

  const server = await addVkCallbackServer(
    token,
    groupId,
    webhookUrl,
    webhookSecret,
  )
  if (!server.ok) {
    await deleteChannel(channel.id, session.sub)
    return {
      ok: false,
      message: `Сообщество проверено, но не удалось зарегистрировать Callback-сервер: ${server.error}. Убедитесь, что приложение доступно по HTTPS.`,
    }
  }

  // 5. Switch on the message_new event for the freshly-registered server.
  const settings = await setVkCallbackSettings(
    token,
    groupId,
    server.data.server_id,
  )
  if (!settings.ok) {
    await deleteVkCallbackServer(token, groupId, server.data.server_id).catch(
      () => {},
    )
    await deleteChannel(channel.id, session.sub)
    return {
      ok: false,
      message: `Не удалось включить события сообщений в VK: ${settings.error}.`,
    }
  }

  // Persist the VK-assigned callback server id so we can delete it on teardown.
  await mergeChannelConfig(channel.id, session.sub, {
    serverId: server.data.server_id,
  })

  revalidatePath('/app/connections')
  revalidatePath('/app')
  return {
    ok: true,
    message: `VK-сообщество «${name}» подключено.`,
    channelId: channel.id,
    sessionStatus: 'online',
  }
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
    codeDelivery:
      delivery === 'app' || delivery === 'sms' ? delivery : null,
  }
}

/* ------------------------------ Lifecycle -------------------------------- */

async function lifecycle(
  channelId: string,
  action: Extract<JobAction, 'restart' | 'stop' | 'logout' | 'pause' | 'resume'>,
  successMsg: string,
): Promise<ChannelResult> {
  const session = await requireManager()
  const channel = await getChannel(channelId, session.sub)
  if (!channel) return { ok: false, message: 'Channel not found.' }

  await enqueueJob({ channelId, managerId: session.sub, action })
  revalidatePath('/app/connections')
  return { ok: true, message: successMsg }
}

export async function restartChannelAction(id: string): Promise<ChannelResult> {
  return lifecycle(id, 'restart', 'Reconnecting…')
}

/**
 * Soft pause: the worker keeps the session connected (account stays linked and
 * healthy) but stops writing inbound messages into the inbox.
 */
export async function pauseChannelAction(id: string): Promise<ChannelResult> {
  return lifecycle(id, 'pause', 'Paused — account stays online, inbox is on hold.')
}

/** Resume writing inbound messages into the inbox. */
export async function resumeChannelAction(id: string): Promise<ChannelResult> {
  return lifecycle(id, 'resume', 'Resumed — new messages will appear in the inbox.')
}

export async function logoutChannelAction(id: string): Promise<ChannelResult> {
  return lifecycle(id, 'logout', 'Logged out.')
}

export async function deleteChannelAction(id: string): Promise<ChannelResult> {
  const session = await requireManager()
  const channel = await getChannel(id, session.sub)
  // Best-effort: stop the live worker session before removing the row. Cloud API
  // WhatsApp channels have no worker session (provider: 'cloud'), so only legacy
  // Baileys WhatsApp + Telegram need a stop job.
  const isCloudWhatsapp =
    channel?.type === 'whatsapp' &&
    (channel.config as { provider?: unknown } | null)?.provider === 'cloud'
  if (
    channel &&
    (channel.type === 'telegram' ||
      (channel.type === 'whatsapp' && !isCloudWhatsapp))
  ) {
    await enqueueJob({
      channelId: id,
      managerId: session.sub,
      action: 'stop',
    }).catch(() => {})
  }
  // MAX: best-effort unsubscribe the webhook so the bot stops POSTing to a
  // route that will no longer exist.
  if (channel && channel.type === 'max') {
    const cfg = channel.config as { token?: unknown }
    if (typeof cfg.token === 'string') {
      try {
        const base = await resolveAppBaseUrl()
        await unsubscribeWebhook(
          decrypt(cfg.token),
          `${base}/api/max/webhook/${id}`,
        )
      } catch (err) {
        console.error('[panel] failed to unsubscribe MAX webhook:', err)
      }
    }
  }
  // VK: best-effort delete the Callback API server so VK stops POSTing to a
  // route that will no longer exist. The token is encrypted + stripped from the
  // sanitized channel config, so re-read the decrypted VK channel directly.
  if (channel && channel.type === 'vk') {
    const vk = await getVkChannelById(id)
    if (vk && vk.serverId != null) {
      try {
        await deleteVkCallbackServer(vk.token, vk.groupId, vk.serverId)
      } catch (err) {
        console.error('[panel] failed to delete VK callback server:', err)
      }
    }
  }
  await deleteChannel(id, session.sub)
  revalidatePath('/app/connections')
  revalidatePath('/app')
  return { ok: true, message: 'Channel removed.' }
}
