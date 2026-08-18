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

/**
 * Пассивная проверка отражённого XSS: в URL добавляется ОДИН безобидный
 * маркер (случайная строка + символы `<>"'`), НЕ являющийся скриптом и ничего
 * не выполняющий. Мы лишь смотрим, вернул ли сервер этот ввод в теле ответа и
 * экранировал ли спецсимволы. Отражение без экранирования — классический
 * признак риска reflected XSS. Это диагностика конфигурации, а не эксплойт.
 */
export interface ReflectionCheck {
  /** Удалось ли выполнить проверку (был ответ с телом). */
  tested: boolean
  /** Отразил ли сервер наш маркер в HTML-ответе. */
  reflected: boolean
  /** Отражены ли спецсимволы `<>"` в СЫРОМ (неэкранированном) виде. */
  rawSpecials: boolean
  /** Есть ли CSP, способный смягчить исполнение инлайн-скриптов. */
  cspPresent: boolean
  /** Итоговая оценка риска отражённого XSS. */
  risk: 'none' | 'low' | 'medium' | 'high'
  /** Короткое пояснение для UI. */
  note: string
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
  /** Пассивная проверка отражения ввода (риск reflected XSS). */
  reflection: ReflectionCheck
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

    const securityHeaders = readHeaders(SECURITY_HEADER_KEYS)
    const cspPresent = securityHeaders.some(
      (h) => h.key === 'content-security-policy' && h.present,
    )

    return {
      url: url.toString(),
      host: url.hostname,
      finalUrl: finalUrl.toString(),
      status: res.status,
      scheme: finalUrl.protocol.replace(':', ''),
      httpsUpgrade: await checkHttpsUpgrade(url),
      securityHeaders,
      disclosure: readHeaders(DISCLOSURE_HEADER_KEYS).filter((h) => h.present),
      cookies,
      reflection: await checkReflection(url, cspPresent),
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
      reflection: {
        tested: false,
        reflected: false,
        rawSpecials: false,
        cspPresent: false,
        risk: 'none',
        note: 'Проверка не выполнена — хост не ответил.',
      },
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
 * Пассивная проверка отражённого XSS (reflected XSS).
 *
 * Добавляем в URL ОДИН безобидный маркер: случайная строка + символы `<>"'`.
 * Это НЕ скрипт и ничего не исполняет — просто «краска», по которой видно,
 * вернул ли сервер наш ввод в теле ответа и экранировал ли спецсимволы.
 * Отражение без экранирования — типичный признак риска reflected XSS.
 * Инструмент только читает ответ (с ограничением объёма), ничего не эксплуатирует.
 */
async function checkReflection(
  url: URL,
  cspPresent: boolean,
): Promise<ReflectionCheck> {
  // Случайное буквенно-цифровое ядро (для точного поиска) + спецсимволы.
  const core = `od${Math.random().toString(36).slice(2, 10)}xr`
  const probeValue = `${core}<>"'`

  const probeUrl = new URL(url.toString())
  probeUrl.searchParams.set('__od_probe', probeValue)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(probeUrl, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'user-agent': 'OMNIDESK-Audit/1.0' },
    })

    // Проверяем отражение только в HTML — в JSON/бинарнике это не про XSS.
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
    const isHtml =
      contentType.includes('text/html') ||
      contentType.includes('application/xhtml')
    if (!isHtml) {
      void res.body?.cancel()
      return {
        tested: true,
        reflected: false,
        rawSpecials: false,
        cspPresent,
        risk: 'none',
        note: 'Ответ не HTML — отражение ввода в разметку неприменимо.',
      }
    }

    const body = await readCapped(res, 262_144)
    const reflected = body.includes(core)
    // Спецсимволы сразу после ядра, отданные «как есть», — сырое отражение.
    const rawSpecials =
      body.includes(`${core}<`) ||
      body.includes(`${core}"`) ||
      body.includes(`${core}'`) ||
      body.includes(`${core}>`)

    let risk: ReflectionCheck['risk'] = 'none'
    let note = 'Ввод в ответе не отражается — reflected XSS маловероятен.'
    if (reflected && rawSpecials) {
      risk = cspPresent ? 'medium' : 'high'
      note = cspPresent
        ? 'Ввод отражается без экранирования. CSP частично смягчает риск, но экранирование обязательно.'
        : 'Ввод отражается без экранирования и без CSP — высокий риск reflected XSS.'
    } else if (reflected) {
      risk = 'low'
      note = 'Ввод отражается, но спецсимволы экранированы — базовая защита есть.'
    }

    return { tested: true, reflected, rawSpecials, cspPresent, risk, note }
  } catch {
    return {
      tested: false,
      reflected: false,
      rawSpecials: false,
      cspPresent,
      risk: 'none',
      note: 'Проверку отражения выполнить не удалось.',
    }
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
    reflection: audit.reflection,
    latencyMs: audit.latencyMs,
  })

  if (!res.ok) return { ok: false, message: res.message, audit }
  return { ok: true, message: 'Готово', report: res.report, audit }
}

/* ===================================================================== */
/*  Сканирование S3-бакетов (пассивное, защитное)                         */
/*                                                                        */
/*  Проверка ПУБЛИЧНОЙ доступности своего S3-бакета: делаем несколько     */
/*  GET-запросов к публичным REST-эндпоинтам Amazon S3 и по коду ответа + */
/*  телу (ListBucketResult / AccessDenied / NoSuchBucket) определяем,     */
/*  открыт ли листинг наружу — типичная мисконфигурация. Инструмент       */
/*  ТОЛЬКО читает публично наблюдаемый ответ: не пишет, не удаляет, не    */
/*  использует учётные данные, не перебирает пути. Часть скрытой панели:  */
/*  гейт requireGod, без audit() (инвариант AGENTS.md §4).                */
/* ===================================================================== */

/** Результат обращения к одному S3-эндпоинту. */
export interface S3Probe {
  /** Стиль адреса: 'virtual-hosted' | 'regional' | 'path-style'. */
  style: string
  /** Реальный URL, к которому обращались. */
  url: string
  /** HTTP-статус ответа или null при сетевой ошибке/таймауте. */
  status: number | null
  /** Задержка ответа, мс. */
  ms: number | null
  /** Классификация ответа. */
  outcome:
    | 'public-listing'
    | 'access-denied'
    | 'not-found'
    | 'redirect'
    | 'error'
    | 'other'
  /** Код ошибки S3 из тела (AccessDenied/NoSuchBucket/PermanentRedirect…). */
  code: string | null
}

export interface S3ScanResult {
  /** Имя бакета (после нормализации ввода). */
  bucket: string
  /** Регион бакета, если удалось определить по редиректу/заголовку. */
  region: string | null
  /** Существует ли бакет: true/false или null (не удалось определить). */
  exists: boolean | null
  /** Открыт ли листинг объектов наружу (критичная мисконфигурация). */
  publicListing: boolean
  /** Число найденных объектов в листинге (если он открыт). */
  objectCount: number | null
  /** Обрезан ли листинг (объектов больше, чем показано). */
  truncated: boolean
  /** Первые несколько ключей объектов (для наглядности). */
  sampleKeys: string[]
  probes: S3Probe[]
  /** Итоговый вердикт. */
  verdict: 'public' | 'private' | 'not-found' | 'unknown'
}

export interface S3ScanActionResult {
  ok: boolean
  message: string
  data?: S3ScanResult
}

/** Валидное имя S3-бакета: 3–63 символа, [a-z0-9.-], край — буква/цифра. */
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

/**
 * Достать имя бакета (и по возможности регион) из ввода: принимает как
 * голое имя (`my-bucket`), так и любой S3-URL
 * (`my-bucket.s3.amazonaws.com`, `s3.eu-west-1.amazonaws.com/my-bucket`, …).
 */
function parseBucket(raw: string): { bucket: string; region: string | null } | null {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed || trimmed.length > 300) return null

  let host = ''
  let pathBucket: string | null = null
  const looksLikeUrl = /^https?:\/\//.test(trimmed) || trimmed.includes('/') || trimmed.includes('.amazonaws.com')
  if (looksLikeUrl) {
    try {
      const u = new URL(/^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`)
      host = u.hostname
      pathBucket = u.pathname.split('/').filter(Boolean)[0] ?? null
    } catch {
      host = ''
    }
  }

  let bucket: string | null = null
  let region: string | null = null

  if (host.endsWith('.amazonaws.com')) {
    // virtual-hosted: {bucket}.s3.amazonaws.com | {bucket}.s3.{region}.amazonaws.com
    const vh = host.match(/^(.+?)\.s3[.-](?:([a-z0-9-]+)\.)?amazonaws\.com$/)
    if (vh) {
      bucket = vh[1]
      region = vh[2] ?? null
    } else {
      // path-style: s3.amazonaws.com/{bucket} | s3.{region}.amazonaws.com/{bucket}
      const ps = host.match(/^s3[.-](?:([a-z0-9-]+)\.)?amazonaws\.com$/)
      if (ps) {
        region = ps[1] ?? null
        bucket = pathBucket
      }
    }
  } else if (!host) {
    // Голое имя бакета (или name/prefix).
    bucket = trimmed.split('/')[0]
  } else {
    // Не-S3 хост — не поддерживаем.
    return null
  }

  if (!bucket || !BUCKET_NAME_RE.test(bucket)) return null
  return { bucket, region: region && /^[a-z0-9-]+$/.test(region) ? region : null }
}

/** Прочитать тело ответа с ограничением по объёму (защита от гигантских листингов). */
async function readCapped(res: Response, maxBytes = 65_536): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      text += decoder.decode(value, { stream: true })
    }
  } catch {
    /* частичное тело — достаточно для классификации */
  } finally {
    void reader.cancel()
  }
  return text
}

interface S3Response {
  status: number | null
  ms: number | null
  region: string | null
  body: string
  error: string | null
}

/** Один GET к S3-эндпоинту: статус, задержка, регион из заголовка, тело. */
async function s3Get(url: string): Promise<S3Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const started = performance.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'user-agent': 'OMNIDESK-S3Scan/1.0' },
    })
    const ms = Math.round(performance.now() - started)
    const region = res.headers.get('x-amz-bucket-region')
    const body = await readCapped(res)
    return { status: res.status, ms, region, body, error: null }
  } catch (err) {
    const aborted =
      err instanceof Error &&
      (err.name === 'AbortError' || err.name === 'TimeoutError')
    return {
      status: null,
      ms: null,
      region: null,
      body: '',
      error: aborted ? 'Таймаут' : 'Нет соединения',
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Достать <Code>…</Code> из XML-ошибки S3. */
function extractCode(body: string): string | null {
  const m = body.match(/<Code>([^<]+)<\/Code>/)
  return m ? m[1] : null
}

/** Классифицировать ответ S3-эндпоинта. */
function classifyOutcome(r: S3Response): S3Probe['outcome'] {
  if (r.status === null) return 'error'
  if (r.status === 200 && r.body.includes('<ListBucketResult')) return 'public-listing'
  if (r.status === 403) return 'access-denied'
  if (r.status === 404) return 'not-found'
  if (r.status === 301 || r.status === 307) return 'redirect'
  return 'other'
}

function toProbe(style: string, url: string, r: S3Response): S3Probe {
  return {
    style,
    url,
    status: r.status,
    ms: r.ms,
    outcome: classifyOutcome(r),
    code: extractCode(r.body),
  }
}

/** Достать первые ключи объектов из ListBucketResult. */
function extractKeys(body: string, limit = 10): string[] {
  const keys: string[] = []
  const re = /<Key>([^<]+)<\/Key>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) && keys.length < limit) keys.push(m[1])
  return keys
}

/** Полное число ключей в ответе (для счётчика). */
function countKeys(body: string): number {
  return (body.match(/<Key>/g) ?? []).length
}

/**
 * Публичный экшен: проверить публичную доступность S3-бакета своего проекта.
 * Гейт requireGod, без audit() — как остальные god-экшены.
 */
export async function secretS3ScanAction(
  rawBucket: string,
): Promise<S3ScanActionResult> {
  await requireGod()

  const parsed = parseBucket(rawBucket)
  if (!parsed) {
    return {
      ok: false,
      message:
        'Некорректное имя бакета. Введите имя S3-бакета или его URL.',
    }
  }

  const { bucket } = parsed
  let region = parsed.region
  const probes: S3Probe[] = []

  // 1) Глобальный virtual-hosted эндпоинт — заодно узнаём регион по редиректу.
  const vhUrl = `https://${bucket}.s3.amazonaws.com/`
  const r1 = await s3Get(vhUrl)
  if (r1.region) region = r1.region
  probes.push(toProbe('virtual-hosted', vhUrl, r1))

  // 2) Если знаем регион (из редиректа/заголовка) — точный региональный запрос.
  let listing: S3Response | null =
    classifyOutcome(r1) === 'public-listing' ? r1 : null
  if (region) {
    const regUrl = `https://${bucket}.s3.${region}.amazonaws.com/`
    const r2 = await s3Get(regUrl)
    if (r2.region) region = r2.region
    probes.push(toProbe('regional', regUrl, r2))
    if (classifyOutcome(r2) === 'public-listing') listing = r2
  }

  // 3) Path-style эндпоинт — на случай нестандартных настроек.
  if (!listing) {
    const psBase = region ? `s3.${region}.amazonaws.com` : 's3.amazonaws.com'
    const psUrl = `https://${psBase}/${bucket}/`
    const r3 = await s3Get(psUrl)
    if (r3.region) region = r3.region
    probes.push(toProbe('path-style', psUrl, r3))
    if (classifyOutcome(r3) === 'public-listing') listing = r3
  }

  // Свести вердикт по всем пробам.
  const outcomes = probes.map((p) => p.outcome)
  const publicListing = outcomes.includes('public-listing')
  let exists: boolean | null = null
  let verdict: S3ScanResult['verdict'] = 'unknown'
  if (publicListing) {
    exists = true
    verdict = 'public'
  } else if (outcomes.includes('access-denied')) {
    exists = true
    verdict = 'private'
  } else if (outcomes.includes('not-found')) {
    exists = false
    verdict = 'not-found'
  }

  const sampleKeys = listing ? extractKeys(listing.body) : []
  const objectCount = listing ? countKeys(listing.body) : null
  const truncated = listing
    ? listing.body.includes('<IsTruncated>true</IsTruncated>')
    : false

  const message =
    verdict === 'public'
      ? 'Внимание: листинг бакета открыт наружу'
      : verdict === 'private'
        ? 'Бакет существует, публичный листинг закрыт'
        : verdict === 'not-found'
          ? 'Бакет не найден'
          : 'Не удалось однозначно определить состояние бакета'

  return {
    ok: true,
    message,
    data: {
      bucket,
      region,
      exists,
      publicListing,
      objectCount,
      truncated,
      sampleKeys,
      probes,
      verdict,
    },
  }
}
