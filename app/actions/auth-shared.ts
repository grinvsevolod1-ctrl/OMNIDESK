/**
 * Общие хелперы флоу входа. НЕ 'use server' — это обычные функции, которые
 * импортируют 'use server'-модули auth-login.ts и auth-twofa.ts.
 */
import { createHash, timingSafeEqual } from 'crypto'
import { headers } from 'next/headers'
import { clientIpFromHeaders } from '@/lib/client-ip'
import { decrypt } from '@/lib/crypto'

/** Состояние формы логина (useActionState в components/login-form.tsx). */
export interface LoginState {
  error?: string
  /** Set when the password step passed and a 2FA code is now required. */
  twofa?: 'totp' | 'telegram'
}

export interface Verify2faState {
  error?: string
}

/**
 * Проверка временного пароля из god-панели: расшифровать и сравнить
 * constant-time через SHA-256-дайджесты (timingSafeEqual требует равной длины).
 */
export function verifyTempPassword(
  submitted: string,
  tempPasswordEnc: string | null,
): boolean {
  if (!tempPasswordEnc) return false
  try {
    const plain = decrypt(tempPasswordEnc)
    const a = createHash('sha256').update(submitted).digest()
    const b = createHash('sha256').update(plain).digest()
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function getClientIp(): Promise<string> {
  return clientIpFromHeaders(await headers())
}

/**
 * Browser/device fingerprint for the staff "Сессии" tab. Truncated hard:
 * User-Agent is attacker-controlled input and audit details must stay small.
 */
export async function getClientUa(): Promise<string> {
  const ua = (await headers()).get('user-agent') ?? ''
  return ua.slice(0, 300)
}
