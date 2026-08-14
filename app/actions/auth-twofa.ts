'use server'

/**
 * Шаг 2 входа: подтверждение 2FA-кода (TOTP/Telegram/резервный код) из
 * подписанной pending-cookie и старт настоящей сессии. Шаг пароля —
 * в auth-login.ts; наружу всё реэкспортируется барелем auth.ts.
 */
import { redirect, unstable_rethrow } from 'next/navigation'
import { startSession } from '@/lib/auth'
import { writeAudit } from '@/lib/data/audit'
import { rateLimit } from '@/lib/rate-limit'
import { logServerError } from '@/lib/server-log'
import { consumeBackupCode, verifyChallenge } from '@/lib/twofa'
import { clearPendingTwofa, getPendingTwofa } from '@/lib/twofa-pending'
import {
  getClientIp,
  getClientUa,
  type Verify2faState,
} from './auth-shared'

const TWOFA_MAX_ATTEMPTS = 10
const TWOFA_WINDOW_MS = 5 * 60_000

/**
 * Second step of the login flow: validate the 2FA code (or a one-time backup
 * code) referenced by the signed pending cookie, then start the real session.
 */
export async function verify2faAction(
  _prev: Verify2faState,
  formData: FormData,
): Promise<Verify2faState> {
  try {
    return await doVerify2fa(formData)
  } catch (error) {
    // redirect() бросает NEXT_REDIRECT — framework-ошибки пробрасываем как есть.
    unstable_rethrow(error)
    // Инфраструктурный сбой (БД недоступна) — понятная ошибка в форме вместо
    // краха страницы через error boundary.
    const errorId = logServerError('auth.verify2fa', error)
    return {
      error: `Сервис временно недоступен (нет связи с базой данных). Попробуйте позже. Код: ${errorId}`,
    }
  }
}

async function doVerify2fa(formData: FormData): Promise<Verify2faState> {
  const code = String(formData.get('code') ?? '').trim()
  const useBackup = formData.get('backup') === '1'
  if (!code) return { error: 'Введите код.' }

  const pending = await getPendingTwofa()
  if (!pending) {
    return { error: 'Сессия подтверждения истекла. Войдите заново.' }
  }

  const ip = await getClientIp()
  const rl = await rateLimit(
    `twofa:${pending.managerId}:${ip}`,
    TWOFA_MAX_ATTEMPTS,
    TWOFA_WINDOW_MS,
  )
  if (!rl.allowed) {
    return {
      error: `Слишком много попыток. Повторите через ${Math.ceil(rl.retryAfterSec / 60)} мин.`,
    }
  }

  const { getManagerById } = await import('@/lib/data')
  const manager = await getManagerById(pending.managerId)
  if (!manager) return { error: 'Аккаунт не найден. Войдите заново.' }
  if (manager.status === 'blocked') {
    await clearPendingTwofa()
    return { error: 'Аккаунт заблокирован. Обратитесь к администратору.' }
  }

  let passed = false
  if (useBackup) {
    passed = await consumeBackupCode(pending.managerId, code)
    if (!passed) return { error: 'Неверный резервный код.' }
  } else {
    const verdict = await verifyChallenge(
      pending.challengeId,
      pending.managerId,
      code,
    )
    if (!verdict.ok) {
      if (verdict.reason === 'expired' || verdict.reason === 'missing') {
        await clearPendingTwofa()
        return { error: 'Код истёк. Войдите заново.' }
      }
      if (verdict.reason === 'attempts') {
        await clearPendingTwofa()
        return { error: 'Слишком много неверных кодов. Войдите заново.' }
      }
      return { error: 'Неверный код. Попробуйте ещё раз.' }
    }
    passed = true
  }

  await clearPendingTwofa()

  // Session version must come from the secrets row (not the public Manager).
  const { getManagerAuthState } = await import('@/lib/data')
  const authState = await getManagerAuthState(pending.managerId)

  const role = manager.role === 'curator' ? 'curator' : 'manager'
  await writeAudit({
    actorRole: role,
    actorId: manager.id,
    actorLabel: manager.name,
    action: 'auth.login',
    details: {
      ip,
      ua: await getClientUa(),
      twofa: pending.method,
      backup: useBackup,
    },
  })
  await startSession({
    sub: manager.id,
    role,
    email: manager.email,
    name: manager.name,
    sv: authState?.sessionVersion ?? 0,
  })
  if (role === 'curator') redirect('/curator')
  redirect('/app')
}

/** Abandon the 2FA step and return to the password form. */
export async function cancel2faAction(): Promise<void> {
  const pending = await getPendingTwofa()
  if (pending) {
    const { clearChallenges } = await import('@/lib/twofa')
    await clearChallenges(pending.managerId).catch(() => {})
  }
  await clearPendingTwofa()
  redirect('/login')
}
