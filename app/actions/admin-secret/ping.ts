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
