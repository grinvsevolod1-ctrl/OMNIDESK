'use server'

import { notFound } from 'next/navigation'
import { lookup } from 'node:dns/promises'
import { requireAdmin } from '@/lib/auth'
import { isGodUnlocked } from '@/lib/god-gate'

/* ===================================================================== */
/*  Ping — god-панель, вкладка «Ping»                                     */
/*                                                                        */
/*  Проверка доступности СВОЕГО домена/URL: HTTP-статус и задержка        */
/*  (latency) за несколько попыток. Часть скрытой панели: подчиняется     */
/*  инвариантам AGENTS.md §4 — обычная админка и Admin AI о вкладке не    */
/*  знают, и НЕТ audit()-вызовов (никаких следов в admin-видимом журнале).*/
/*                                                                        */
/*  Инструмент только читает статус-код и меряет время ответа. Он НЕ      */
/*  извлекает и не сохраняет тело ответа, cookie, заголовки или любые     */
/*  учётные данные — это простой uptime-чекер, а не сканер.               */
/* ===================================================================== */

/**
 * Гейт: admin-сессия И god-разблокировка (та же форма, что у gmt.ts и
 * sites.ts). Заблокированный гейт отвечает 404. Сознательно без audit().
 */
async function requireGod(): Promise<void> {
  await requireAdmin()
  if (!(await isGodUnlocked())) notFound()
}

export interface PingAttempt {
  /** Порядковый номер попытки (с 1). */
  seq: number
  /** true, если получили HTTP-ответ (любой статус). */
  ok: boolean
  /** HTTP-статус ответа или null при сетевой ошибке/таймауте. */
  status: number | null
  /** Время до ответа в миллисекундах или null при ошибке. */
  ms: number | null
  /** Человекочитаемая причина ошибки, если ответа не было. */
  error: string | null
}

export interface PingResult {
  /** Итоговый URL, к которому реально обращались (после нормализации). */
  url: string
  /** Хост, извлечённый из URL. */
  host: string
  /** Разрешённый IP-адрес (для наглядности), если удалось. */
  ip: string | null
  attempts: PingAttempt[]
  /** Число успешных ответов. */
  received: number
  /** Число потерянных (ошибка/таймаут) попыток. */
  lost: number
  /** Статистика задержки по успешным попыткам, мс. */
  min: number | null
  avg: number | null
  max: number | null
}

export interface PingActionResult {
  ok: boolean
  message: string
  data?: PingResult
}

const MAX_ATTEMPTS = 6
const DEFAULT_ATTEMPTS = 4
const TIMEOUT_MS = 10_000

/**
 * Нормализует пользовательский ввод в http(s)-URL. Возвращает null, если
 * ввод некорректен или использует не-HTTP схему (защита от file://, gopher://
 * и подобных — инструмент проверяет только веб-доступность).
 */
function normalizeUrl(raw: string): URL | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 2048) return null
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.hostname) return null
    return u
  } catch {
    return null
  }
}

/**
 * Проверить доступность URL: сделать `count` последовательных запросов,
 * измерить задержку каждого и вернуть сводную статистику.
 *
 * Один запрос: GET с таймаутом; читается ТОЛЬКО статус-код и время ответа,
 * тело ответа не загружается (соединение закрывается через AbortController
 * сразу после получения заголовков).
 */
export async function secretPingAction(
  rawUrl: string,
  count = DEFAULT_ATTEMPTS,
): Promise<PingActionResult> {
  await requireGod()

  const url = normalizeUrl(rawUrl)
  if (!url) {
    return {
      ok: false,
      message: 'Некорректный адрес. Введите домен или http(s)-URL.',
    }
  }

  const attemptsCount =
    Number.isInteger(count) && count >= 1 && count <= MAX_ATTEMPTS
      ? count
      : DEFAULT_ATTEMPTS

  // Резолвим IP для наглядности (best-effort, не влияет на сам пинг).
  let ip: string | null = null
  try {
    const res = await lookup(url.hostname)
    ip = res.address
  } catch {
    ip = null
  }

  const attempts: PingAttempt[] = []
  for (let i = 0; i < attemptsCount; i++) {
    attempts.push(await pingOnce(url, i + 1))
  }

  const okAttempts = attempts.filter((a) => a.ms !== null)
  const times = okAttempts.map((a) => a.ms as number)
  const received = okAttempts.length
  const lost = attempts.length - received

  return {
    ok: true,
    message: received > 0 ? 'Готово' : 'Хост не ответил ни разу',
    data: {
      url: url.toString(),
      host: url.hostname,
      ip,
      attempts,
      received,
      lost,
      min: times.length ? Math.min(...times) : null,
      avg: times.length
        ? Math.round(times.reduce((s, t) => s + t, 0) / times.length)
        : null,
      max: times.length ? Math.max(...times) : null,
    },
  }
}

/** Один замер: время от запроса до заголовков ответа. */
async function pingOnce(url: URL, seq: number): Promise<PingAttempt> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const started = performance.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'user-agent': 'OMNIDESK-Ping/1.0' },
    })
    const ms = Math.round(performance.now() - started)
    // Закрываем тело, чтобы не тянуть его целиком — нам нужен только статус.
    void res.body?.cancel()
    return { seq, ok: true, status: res.status, ms, error: null }
  } catch (err) {
    const aborted =
      err instanceof Error &&
      (err.name === 'AbortError' || err.name === 'TimeoutError')
    return {
      seq,
      ok: false,
      status: null,
      ms: null,
      error: aborted ? 'Таймаут' : 'Нет соединения',
    }
  } finally {
    clearTimeout(timer)
  }
}

/* ===================================================================== */
/*  Аудит безопасности (пассивный)                                        */
/*                                                                        */
/*  Строго защитная проверка СВОЕГО домена: делаем ОДИН GET по адресу     */
/*  (плюс один запрос http:// для проверки upgrade на https) и читаем     */
/*  только ПУБЛИЧНО наблюдаемые метаданные ответа — заголовки            */
/*  безопасности, флаги cookie (без значений), раскрытие версий ПО.       */
/*  Никаких переборов путей, портов, эксплойтов или полезной нагрузки —   */
/*  это инвентаризация конфигурации для харденинга, а не сканер атак.     */
/* ===================================================================== */

/** Заголовки безопасности, наличие/значение которых мы проверяем. */
const SECURITY_HEADER_KEYS = [
  'strict-transport-security',
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
] as const

/** Заголовки, раскрывающие используемое ПО и его версии. */
const DISCLOSURE_HEADER_KEYS = [
  'server',
  'x-powered-by',
  'x-aspnet-version',
  'x-aspnetmvc-version',
  'x-generator',
] as const

export interface HeaderCheck {
  key: string
  present: boolean
  value: string | null
}

export interface CookieFlags {
  /** Только имя cookie — значение НИКОГДА не читается и не сохраняется. */
  name: string
  secure: boolean
  httpOnly: boolean
  sameSite: string | null
}

export interface SecurityAudit {
  url: string
  host: string
  finalUrl: string
  status: number | null
  scheme: string
  /** Редиректит ли http:// на https:// ('yes' | 'no' | 'unknown'). */
  httpsUpgrade: 'yes' | 'no' | 'unknown'
  securityHeaders: HeaderCheck[]
  disclosure: HeaderCheck[]
  cookies: CookieFlags[]
  latencyMs: number | null
  error: string | null
}

export interface SecurityAuditActionResult {
  ok: boolean
  message: string
  data?: SecurityAudit
}

/** Разобрать один Set-Cookie в имя + флаги безопасности (без значения). */
function parseCookieFlags(raw: string): CookieFlags {
  const [pair, ...attrs] = raw.split(';')
  const name = (pair ?? '').split('=')[0]?.trim() || '(без имени)'
  const lower = attrs.map((a) => a.trim().toLowerCase())
  const sameSiteAttr = lower.find((a) => a.startsWith('samesite='))
  return {
    name,
    secure: lower.includes('secure'),
    httpOnly: lower.includes('httponly'),
    sameSite: sameSiteAttr ? sameSiteAttr.split('=')[1] ?? null : null,
  }
}

/** Собрать пассивный аудит по URL. Вызывается только из гейт-экшена. */
async function collectAudit(url: URL): Promise<SecurityAudit> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const started = performance.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'user-agent': 'OMNIDESK-Audit/1.0' },
    })
    const latencyMs = Math.round(performance.now() - started)
    void res.body?.cancel()

    const finalUrl = new URL(res.url || url.toString())
    const readHeaders = (keys: readonly string[]): HeaderCheck[] =>
      keys.map((key) => {
        const value = res.headers.get(key)
        return { key, present: value !== null, value }
      })

    // Флаги cookie — только имена и флаги, значения не трогаем.
    let cookies: CookieFlags[] = []
    try {
      const setCookies =
        typeof res.headers.getSetCookie === 'function'
          ? res.headers.getSetCookie()
          : []
      cookies = setCookies.map(parseCookieFlags)
    } catch {
      cookies = []
    }

    return {
      url: url.toString(),
      host: url.hostname,
      finalUrl: finalUrl.toString(),
      status: res.status,
      scheme: finalUrl.protocol.replace(':', ''),
      httpsUpgrade: await checkHttpsUpgrade(url),
      securityHeaders: readHeaders(SECURITY_HEADER_KEYS),
      disclosure: readHeaders(DISCLOSURE_HEADER_KEYS).filter((h) => h.present),
      cookies,
      latencyMs,
      error: null,
    }
  } catch (err) {
    const aborted =
      err instanceof Error &&
      (err.name === 'AbortError' || err.name === 'TimeoutError')
    return {
      url: url.toString(),
      host: url.hostname,
      finalUrl: url.toString(),
      status: null,
      scheme: url.protocol.replace(':', ''),
      httpsUpgrade: 'unknown',
      securityHeaders: SECURITY_HEADER_KEYS.map((key) => ({
        key,
        present: false,
        value: null,
      })),
      disclosure: [],
      cookies: [],
      latencyMs: null,
      error: aborted ? 'Таймаут' : 'Нет соединения',
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Проверить, редиректит ли http:// на https:// (best-effort). */
async function checkHttpsUpgrade(url: URL): Promise<'yes' | 'no' | 'unknown'> {
  const httpUrl = new URL(url.toString())
  httpUrl.protocol = 'http:'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(httpUrl, {
      method: 'HEAD',
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'user-agent': 'OMNIDESK-Audit/1.0' },
    })
    void res.body?.cancel()
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') ?? ''
      return loc.toLowerCase().startsWith('https:') ? 'yes' : 'no'
    }
    return res.status < 400 ? 'no' : 'unknown'
  } catch {
    return 'unknown'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Публичный экшен: собрать пассивный аудит безопасности своего домена.
 * Гейт requireGod, без audit() — как остальные god-экшены.
 */
export async function secretSecurityAuditAction(
  rawUrl: string,
): Promise<SecurityAuditActionResult> {
  await requireGod()
  const url = normalizeUrl(rawUrl)
  if (!url) {
    return {
      ok: false,
      message: 'Некорректный адрес. Введите домен или http(s)-URL.',
    }
  }
  const data = await collectAudit(url)
  if (data.error && data.status === null) {
    return { ok: false, message: `Хост не ответил: ${data.error}`, data }
  }
  return { ok: true, message: 'Готово', data }
}

/* ------------------------- AI-заключение (харденинг) --------------------- */

// Мягкий rate-limit на дорогой вызов модели: 6 заключений в минуту суммарно
// (как у god-отчёта). In-memory, best-effort — панель однопроцессная.
const assessTimestamps: number[] = []

export interface PentestActionResult {
  ok: boolean
  message: string
  /** Markdown-текст заключения. */
  report?: string
  /** Данные аудита, на которых построено заключение (для отображения). */
  audit?: SecurityAudit
}

/**
 * Собрать пассивный аудит и получить от AI Gateway ЗАЩИТНОЕ заключение
 * (харденинг) по своему домену. Гейт requireGod, без audit().
 */
export async function secretSecurityAssessAction(
  rawUrl: string,
): Promise<PentestActionResult> {
  await requireGod()

  const url = normalizeUrl(rawUrl)
  if (!url) {
    return {
      ok: false,
      message: 'Некорректный адрес. Введите домен или http(s)-URL.',
    }
  }

  const now = Date.now()
  while (assessTimestamps.length && now - assessTimestamps[0] > 60_000) {
    assessTimestamps.shift()
  }
  if (assessTimestamps.length >= 6) {
    return {
      ok: false,
      message: 'Слишком часто. Подождите минуту и попробуйте снова.',
    }
  }
  assessTimestamps.push(now)

  const audit = await collectAudit(url)
  if (audit.error && audit.status === null) {
    return { ok: false, message: `Хост не ответил: ${audit.error}`, audit }
  }

  // Ленивый импорт: тянет server-only + gateway-пл'юмбинг только при запросе.
  const { assessSecurity } = await import('@/lib/god-pentest')
  const res = await assessSecurity({
    host: audit.host,
    finalUrl: audit.finalUrl,
    status: audit.status,
    scheme: audit.scheme,
    httpsUpgrade: audit.httpsUpgrade,
    securityHeaders: audit.securityHeaders,
    disclosure: audit.disclosure,
    cookies: audit.cookies,
    latencyMs: audit.latencyMs,
  })

  if (!res.ok) return { ok: false, message: res.message, audit }
  return { ok: true, message: 'Готово', report: res.report, audit }
}
