'use server'

import { requireAdmin } from '@/lib/auth'
import {
  createChannel,
  enqueueJob,
  getChannelById,
  updateChannelSessionById,
} from '@/lib/data'
import { fetchTelegramQr } from '@/lib/worker-client'
import {
  validateProxyForType,
  type AdminAccountResult,
  type ChannelStatusSnapshot,
} from './admin-accounts-shared'

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
 * Admin: create a Telegram account and begin ONE-BUTTON QR login. No phone, no
 * SMS: the worker exports a login token (auth.exportLoginToken) and the account
 * owner scans the QR from Telegram → Settings → Devices → Link Desktop Device.
 * Only a 2FA cloud password (if set) remains — that reuses the existing
 * password_pending flow.
 */
export async function adminConnectTelegramQrAction(
  formData: FormData,
): Promise<AdminAccountResult> {
  await requireAdmin()
  const name = String(formData.get('name') ?? '').trim() || 'Telegram account'
  const managerId = String(formData.get('managerId') ?? '').trim()
  const proxyId = String(formData.get('proxyId') ?? '').trim() || null

  if (!managerId) return { ok: false, message: 'Выберите менеджера-владельца.' }
  const proxyError = await validateProxyForType(proxyId, 'telegram')
  if (proxyError) return { ok: false, message: proxyError }

  const attemptId = globalThis.crypto.randomUUID()
  const channel = await createChannel({
    managerId,
    type: 'telegram',
    name,
    detail: 'QR-подключение',
    status: 'pending',
    sessionStatus: 'starting',
    phone: null,
    proxyId,
    config: {},
  })

  await enqueueJob({
    channelId: channel.id,
    managerId,
    action: 'start_qr',
    payload: { attemptId },
  })

  return {
    ok: true,
    message: 'Генерируем QR-код…',
    channelId: channel.id,
    sessionStatus: 'starting',
  }
}

/**
 * Restart QR login on an EXISTING channel (e.g. the QR expired unwatched, the
 * account logged out, or the phone-code flow stalled and the admin prefers QR).
 */
export async function adminRestartTelegramQrAction(
  channelId: string,
): Promise<AdminAccountResult> {
  await requireAdmin()
  const channel = await getChannelById(channelId)
  if (!channel || !channel.managerId || channel.type !== 'telegram') {
    return { ok: false, message: 'Аккаунт не найден.' }
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
    action: 'start_qr',
    payload: { attemptId },
  })
  return {
    ok: true,
    message: 'Генерируем QR-код…',
    channelId,
    sessionStatus: 'starting',
  }
}

/**
 * Poll the live QR deep link for a channel whose QR login is pending. The link
 * lives only in worker memory (never persisted); Telegram rotates it ~every
 * 30s, so the wizard polls this and re-renders the QR image.
 */
export async function adminGetTelegramQrAction(
  channelId: string,
): Promise<{ qr: string | null; expiresAt: number | null }> {
  await requireAdmin()
  const channel = await getChannelById(channelId)
  if (!channel || channel.type !== 'telegram') return { qr: null, expiresAt: null }
  const data = await fetchTelegramQr(channelId)
  return data ?? { qr: null, expiresAt: null }
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
