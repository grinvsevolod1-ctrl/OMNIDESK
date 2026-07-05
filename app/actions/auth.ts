'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import {
  comparePassword,
  endSession,
  startSession,
  verifyAdminCredentials,
} from '@/lib/auth'
import { getManagerByEmail } from '@/lib/data'
import { rateLimit } from '@/lib/rate-limit'

export interface LoginState {
  error?: string
}

// Brute-force protection: cap login attempts per client IP and per target
// email within a rolling window. The admin password is compared directly and
// manager passwords are bcrypt-hashed, so throttling here is the main defence
// against online password guessing.
const LOGIN_MAX_ATTEMPTS = 8
const LOGIN_WINDOW_MS = 5 * 60_000 // 5 minutes

async function getClientIp(): Promise<string> {
  // Forwarded headers are spoofable unless a trusted reverse-proxy sits in
  // front. Deployments exposing Node directly can set TRUST_PROXY=false so a
  // client cannot forge its IP to dodge the per-IP brute-force limit below.
  if (process.env.TRUST_PROXY === 'false') return 'unknown'
  const h = await headers()
  const fwd = h.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0]!.trim()
  return h.get('x-real-ip')?.trim() || 'unknown'
}

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')

  if (!email || !password) {
    return { error: 'Enter both email and password.' }
  }

  // Rate limit before doing any credential work.
  const ip = await getClientIp()
  const ipLimit = rateLimit(`login:ip:${ip}`, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS)
  const emailLimit = rateLimit(
    `login:email:${email.toLowerCase()}`,
    LOGIN_MAX_ATTEMPTS,
    LOGIN_WINDOW_MS,
  )
  if (!ipLimit.allowed || !emailLimit.allowed) {
    const retry = Math.max(ipLimit.retryAfterSec, emailLimit.retryAfterSec)
    return {
      error: `Too many login attempts. Try again in ${Math.ceil(retry / 60)} min.`,
    }
  }

  // 1) Admin is authenticated via environment variables.
  if (verifyAdminCredentials(email, password)) {
    await startSession({
      sub: 'admin',
      role: 'admin',
      email: email.toLowerCase(),
      name: 'Administrator',
    })
    redirect('/admin')
  }

  // 2) Managers are stored in the database.
  const manager = await getManagerByEmail(email)
  if (!manager) {
    return { error: 'Invalid email or password.' }
  }
  if (manager.status === 'blocked') {
    return { error: 'This account has been blocked. Contact your admin.' }
  }
  const ok = await comparePassword(password, manager.passwordHash)
  if (!ok) {
    return { error: 'Invalid email or password.' }
  }

  await startSession({
    sub: manager.id,
    role: 'manager',
    email: manager.email,
    name: manager.name,
    sv: manager.sessionVersion,
  })
  redirect('/app')
}

export async function logoutAction(): Promise<void> {
  await endSession()
  redirect('/login')
}
