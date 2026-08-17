'use server'

import QRCode from 'qrcode'
import { comparePassword, getSession } from '@/lib/auth'
import { getManagerByEmail, getManagerById } from '@/lib/data'
import { writeAudit } from '@/lib/data/audit'
import { rateLimit } from '@/lib/rate-limit'
import {
  clearChallenges,
  createChallenge,
  disableTwofa,
  enableTelegram,
  enableTotp,
  generateBackupCodes,
  generateLoginCode,
  getTwofaConfig,
  newTotpSecret,
  telegramBroadcast,
  telegramDiscoverChats,
  telegramGetMe,
  totpUri,
  verifyChallenge,
  verifyTotp,
} from '@/lib/twofa'

/**
 * Self-service 2FA wizards for managers and curators (Settings → Security).
 * Every action authenticates the caller and operates ONLY on their own
 * account. Admin bypass paths live in the login flow, not here.
 */

async function requireStaff(): Promise<{
  id: string
  name: string
  email: string
  role: 'manager' | 'curator' | 'head'
} | null> {
  const session = await getSession()
  if (
    !session ||
    (session.role !== 'manager' &&
      session.role !== 'curator' &&
      session.role !== 'head')
  ) {
    return null
  }
  // По id: email мог быть изменён в профиле и разойтись с сессией до её
  // перевыпуска.
  const account = await getManagerById(session.sub)
  if (!account) return null
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    role: session.role,
  }
}

/* ------------------------------ Status ------------------------------- */

export interface TwofaStatus {
  method: 'off' | 'totp' | 'telegram'
  enabledAt: string | null
  backupCodesLeft: number
  telegramRecipients: number
}

export async function getTwofaStatusAction(): Promise<TwofaStatus | null> {
  const staff = await requireStaff()
  if (!staff) return null
  const cfg = await getTwofaConfig(staff.id)
  return {
    method: cfg.method,
    enabledAt: cfg.enabledAt ? new Date(cfg.enabledAt).toISOString() : null,
    backupCodesLeft: cfg.backupCodes.length,
    telegramRecipients: cfg.telegramChatIds.length,
  }
}

/* ------------------------------- TOTP -------------------------------- */

export interface TotpSetupStart {
  ok: boolean
  message?: string
  secret?: string
  qrDataUrl?: string
}

/** Step 1: fresh secret + QR. Nothing is persisted until confirmation. */
export async function startTotpSetupAction(): Promise<TotpSetupStart> {
  const staff = await requireStaff()
  if (!staff) return { ok: false, message: 'Нет доступа.' }
  const secret = await newTotpSecret()
  const uri = await totpUri(secret, staff.email)
  const qrDataUrl = await QRCode.toDataURL(uri, {
    margin: 1,
    width: 240,
    color: { dark: '#000000', light: '#ffffff' },
  })
  return { ok: true, secret, qrDataUrl }
}

export interface TwofaEnableResult {
  ok: boolean
  message?: string
  backupCodes?: string[]
}

/** Step 2: employee proves the app is set up by entering a valid code. */
export async function confirmTotpSetupAction(
  secret: string,
  code: string,
): Promise<TwofaEnableResult> {
  const staff = await requireStaff()
  if (!staff) return { ok: false, message: 'Нет доступа.' }
  const rl = await rateLimit(`twofa-setup:${staff.id}`, 10, 5 * 60_000)
  if (!rl.allowed) {
    return { ok: false, message: 'Слишком много попыток. Подождите немного.' }
  }
  if (!secret || !(await verifyTotp(secret, code))) {
    return { ok: false, message: 'Неверный код. Проверьте приложение и время на телефоне.' }
  }
  const { codes, hashes } = await generateBackupCodes()
  await enableTotp(staff.id, secret, hashes)
  await clearChallenges(staff.id)
  await writeAudit({
    actorRole: staff.role,
    actorId: staff.id,
    actorLabel: staff.name,
    action: 'account.twofa_enable',
    entityType: 'manager',
    entityId: staff.id,
    details: { method: 'totp' },
  })
  return { ok: true, backupCodes: codes }
}

/* ----------------------------- Telegram ------------------------------ */

export interface BotCheckResult {
  ok: boolean
  message?: string
  botUsername?: string
  botName?: string
}

/** Validate the BotFather token via getMe (free Bot API call). */
export async function checkBotTokenAction(
  token: string,
): Promise<BotCheckResult> {
  const staff = await requireStaff()
  if (!staff) return { ok: false, message: 'Нет доступа.' }
  const rl = await rateLimit(`twofa-bot:${staff.id}`, 15, 5 * 60_000)
  if (!rl.allowed) {
    return { ok: false, message: 'Слишком много попыток. Подождите немного.' }
  }
  const clean = token.trim()
  if (!/^\d+:[\w-]{30,}$/.test(clean)) {
    return {
      ok: false,
      message: 'Это не похоже на токен бота. Формат: 1234567890:AAE…',
    }
  }
  const info = await telegramGetMe(clean)
  if (!info) {
    return {
      ok: false,
      message: 'Telegram не принял токен. Скопируйте его заново из @BotFather.',
    }
  }
  return { ok: true, botUsername: info.username, botName: info.firstName }
}

export interface DiscoverChatsResult {
  ok: boolean
  message?: string
  chats?: { chatId: string; name: string }[]
}

/** "Найти мой ID": list private chats that wrote to the bot. */
export async function discoverChatIdsAction(
  token: string,
): Promise<DiscoverChatsResult> {
  const staff = await requireStaff()
  if (!staff) return { ok: false, message: 'Нет доступа.' }
  const chats = await telegramDiscoverChats(token.trim())
  if (chats.length === 0) {
    return {
      ok: false,
      message:
        'Пока никого не видно. Откройте своего бота в Telegram, нажмите «Start» и попробуйте ещё раз.',
    }
  }
  return { ok: true, chats }
}

export interface TelegramTestResult {
  ok: boolean
  message?: string
  challengeId?: string
}

/** Send a confirmation code to every chat ID before enabling. */
export async function sendTelegramSetupCodeAction(
  token: string,
  chatIds: string[],
): Promise<TelegramTestResult> {
  const staff = await requireStaff()
  if (!staff) return { ok: false, message: 'Нет доступа.' }
  const rl = await rateLimit(`twofa-send:${staff.id}`, 6, 5 * 60_000)
  if (!rl.allowed) {
    return { ok: false, message: 'Слишком много кодов. Подождите пару минут.' }
  }
  const cleanIds = chatIds.map((c) => c.trim()).filter(Boolean)
  if (cleanIds.length === 0) {
    return { ok: false, message: 'Добавьте хотя бы один ID получателя.' }
  }
  const code = generateLoginCode()
  const delivered = await telegramBroadcast(
    token.trim(),
    cleanIds,
    `Код подтверждения Omnidesk: ${code}\nВведите его в мастере подключения 2FA.`,
  )
  if (delivered === 0) {
    return {
      ok: false,
      message:
        'Не удалось доставить код ни одному получателю. Проверьте, что вы написали боту /start, и что ID верные.',
    }
  }
  const challengeId = await createChallenge(staff.id, 'telegram', code)
  return {
    ok: true,
    challengeId,
    message: `Код отправлен (доставлено: ${delivered} из ${cleanIds.length}).`,
  }
}

/** Final step: verify the delivered code and enable Telegram 2FA. */
export async function confirmTelegramSetupAction(
  challengeId: string,
  code: string,
  token: string,
  chatIds: string[],
): Promise<TwofaEnableResult> {
  const staff = await requireStaff()
  if (!staff) return { ok: false, message: 'Нет доступа.' }
  const verdict = await verifyChallenge(challengeId, staff.id, code)
  if (!verdict.ok) {
    const msg =
      verdict.reason === 'expired' || verdict.reason === 'missing'
        ? 'Код истёк. Отправьте новый.'
        : verdict.reason === 'attempts'
          ? 'Слишком много неверных попыток. Отправьте новый код.'
          : 'Неверный код. Попробуйте ещё раз.'
    return { ok: false, message: msg }
  }
  const cleanIds = chatIds.map((c) => c.trim()).filter(Boolean)
  const info = await telegramGetMe(token.trim())
  if (!info || cleanIds.length === 0) {
    return { ok: false, message: 'Токен или получатели больше не валидны.' }
  }
  const { codes, hashes } = await generateBackupCodes()
  await enableTelegram(staff.id, token.trim(), cleanIds, hashes)
  await clearChallenges(staff.id)
  await writeAudit({
    actorRole: staff.role,
    actorId: staff.id,
    actorLabel: staff.name,
    action: 'account.twofa_enable',
    entityType: 'manager',
    entityId: staff.id,
    details: { method: 'telegram', recipients: cleanIds.length },
  })
  return { ok: true, backupCodes: codes }
}

/* ------------------------------ Disable ------------------------------ */

export async function disableTwofaAction(
  currentPassword: string,
): Promise<{ ok: boolean; message: string }> {
  const staff = await requireStaff()
  if (!staff) return { ok: false, message: 'Нет доступа.' }
  const account = await getManagerByEmail(staff.email)
  if (!account) return { ok: false, message: 'Аккаунт не найден.' }
  const ok = await comparePassword(currentPassword, account.passwordHash)
  if (!ok) return { ok: false, message: 'Неверный текущий пароль.' }
  await disableTwofa(staff.id)
  await clearChallenges(staff.id)
  await writeAudit({
    actorRole: staff.role,
    actorId: staff.id,
    actorLabel: staff.name,
    action: 'account.twofa_disable',
    entityType: 'manager',
    entityId: staff.id,
  })
  return { ok: true, message: 'Двухфакторная защита отключена.' }
}
