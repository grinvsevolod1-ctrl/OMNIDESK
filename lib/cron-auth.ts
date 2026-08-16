import 'server-only'

/**
 * Единый гейт для всех /api/cron/* роутов: bearer-проверка CRON_SECRET.
 *
 * До рефакторинга этот блок (secret → 503, timingSafeEqual → 401) был
 * скопирован в каждом из 7 крон-роутов; теперь контракт живёт в одном месте.
 *
 * Контракт (не менять — на него завязаны pm2-скрипты scripts/cron-*.mjs):
 * - CRON_SECRET не задан      → 503 service_not_configured (fail-closed);
 * - заголовок не совпал       → 401 unauthorized;
 * - совпал                    → null (роут продолжает работу).
 *
 * Сравнение — constant-time через timingSafeEqual с предварительной проверкой
 * длины (timingSafeEqual бросает на буферах разной длины).
 */
import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

export function requireCronAuth(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: 'service_not_configured' },
      { status: 503 },
    )
  }
  const auth = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${secret}`
  const authorized =
    auth.length === expected.length &&
    timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
  if (!authorized) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 },
    )
  }
  return null
}
