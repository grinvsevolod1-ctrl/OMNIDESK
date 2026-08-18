'use server'

import { notFound } from 'next/navigation'
import { lookup, resolveTxt, resolveCaa } from 'node:dns/promises'
import { isIP } from 'node:net'
import { connect as tlsConnect, checkServerIdentity } from 'node:tls'
import type { PeerCertificate } from 'node:tls'
import { requireAdmin } from '@/lib/auth'
import { isGodUnlocked } from '@/lib/god-gate'
import { computeScore, type SecurityScore } from '@/lib/god-audit-score'

export type { SecurityScore }

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
  /**
   * «Холодная» попытка — первая в серии: включает установку TCP/TLS-соединения,
   * поэтому её задержка объективно выше и её нельзя считать типичной.
   */
  cold?: boolean
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
  /**
   * Средняя задержка БЕЗ учёта первой (холодной) попытки — «тёплый» пинг,
   * когда соединение уже установлено. null, если тёплых попыток нет.
   */
  warmAvg: number | null
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
 * Реалистичный браузерный User-Agent. Кастомные UA часто режутся WAF/CDN
 * (403/таймаут), из-за чего живой сайт выглядел бы недоступным — поэтому
 * все пассивные проверки представляются обычным браузером.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** Приватный/служебный IP (loopback, RFC1918, link-local, CGNAT, ULA). */
function isPrivateIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const p = ip.split('.').map(Number)
    if (p.some((n) => Number.isNaN(n))) return false
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true
    if (p[0] === 169 && p[1] === 254) return true // link-local / metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
    if (p[0] === 192 && p[1] === 168) return true
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true // CGNAT
    return false
  }
  if (v === 6) {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fe80')) return true // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // ULA
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateIp(mapped[1])
    return false
  }
  return false
}

/**
 * Защита от SSRF: инструмент проверяет ПУБЛИЧНЫЕ домены владельца, поэтому
 * запросы к внутренним/облачным адресам (127.0.0.1, 169.254.169.254, RFC1918
 * и т.п.) блокируются. Возвращает текст ошибки или null, если хост публичный.
 * Неразрешимый хост пропускаем — fetch сам упадёт естественной ошибкой.
 */
async function guardPublicHost(hostname: string): Promise<string | null> {
  if (isIP(hostname) && isPrivateIp(hostname)) {
    return 'Адрес указывает на внутренний/приватный IP — проверка заблокирована.'
  }
  try {
    // all:true — проверяем ВСЕ адреса (и A, и AAAA): хост с несколькими
    // записями, где хотя бы одна приватная (DNS-rebinding), блокируется.
    const records = await lookup(hostname, { all: true })
    if (records.some((r) => isPrivateIp(r.address))) {
      return 'Адрес разрешается во внутренний/приватный IP — проверка заблокирована.'
    }
  } catch {
    return null
  }
  return null
}

/**
 * SSRF-безопасный fetch со СЛЕЖЕНИЕМ за редиректами вручную: каждый переход
 * повторно проверяется guardPublicHost, поэтому публичный хост не сможет
 * увести нас 302-редиректом на 169.254.169.254 или внутренний адрес (что
 * возможно при redirect:'follow'). Возвращает финальный ответ и итоговый URL.
 */
async function guardedFetch(
  target: URL | string,
  init: RequestInit,
  maxRedirects = 5,
): Promise<{ res: Response; finalUrl: URL }> {
  let current = new URL(target.toString())
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const blocked = await guardPublicHost(current.hostname)
    if (blocked) throw new Error('ssrf-blocked')
    const res = await fetch(current, { ...init, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (loc) {
        void res.body?.cancel()
        let next: URL
        try {
          next = new URL(loc, current)
        } catch {
          return { res, finalUrl: current }
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new Error('ssrf-bad-scheme')
        }
        current = next
        continue
      }
    }
    return { res, finalUrl: current }
  }
  throw new Error('too-many-redirects')
}

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
 * сразу пос��е получения заголовков).
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

  const blocked = await guardPublicHost(url.hostname)
  if (blocked) return { ok: false, message: blocked }

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

  // Последовательные попытки; первая — «холодная» (установка TCP/TLS).
  const attempts: PingAttempt[] = []
  for (let i = 0; i < attemptsCount; i++) {
    attempts.push(await pingOnce(url, i + 1, i === 0))
  }

  const okAttempts = attempts.filter((a) => a.ms !== null)
  const times = okAttempts.map((a) => a.ms as number)
  const received = okAttempts.length
  const lost = attempts.length - received

  // Тёплая средняя — по успешным попыткам, исключая холодную (первую).
  const warmTimes = okAttempts.filter((a) => !a.cold).map((a) => a.ms as number)

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
      warmAvg: warmTimes.length
        ? Math.round(warmTimes.reduce((s, t) => s + t, 0) / warmTimes.length)
        : null,
    },
  }
}

/** Один замер: время от запроса до заголовков ответа. */
async function pingOnce(
  url: URL,
  seq: number,
  cold: boolean,
): Promise<PingAttempt> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const started = performance.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'user-agent': BROWSER_UA },
    })
    const ms = Math.round(performance.now() - started)
    // Закрываем тело, чтобы не тянуть его целиком — нам нужен только статус.
    void res.body?.cancel()
    return { seq, ok: true, status: res.status, ms, error: null, cold }
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
      cold,
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
  /** Отражён ли наш маркер в заголовке ответа (риск header injection/XSS). */
  headerReflected: boolean
  /** Есть ли CSP, способный смягчить исполнение инлайн-скриптов. */
  cspPresent: boolean
  /** Итоговая оценка риска отражённого XSS. */
  risk: 'none' | 'low' | 'medium' | 'high'
  /** Короткое пояснение для UI. */
  note: string
}

/**
 * Пассивная проверка TLS-сертификата: открываем TLS-соединение и читаем
 * ПУБЛИЧНО предъявляемый сертификат (срок, издатель, протокол). Ничего не
 * отправляем и не эксплуатируем — то же, что видит любой браузер.
 */
export interface TlsCheck {
  tested: boolean
  /** Протокол (TLSv1.2 / TLSv1.3 / …), если удалось согласовать. */
  protocol: string | null
  /** Издатель сертификата (CN организации). */
  issuer: string | null
  /** Дата окончания действия (ISO), если прочитана. */
  validTo: string | null
  /** Осталось д��ей до истечения (может быть отрицательным). */
  daysLeft: number | null
  /** Совпадает ли имя хоста с сертификатом. */
  hostnameMatch: boolean
  /** Доверенная ли цепочка (не самоподписан, известный CA). */
  authorized: boolean
  /** Итоговая оценка. */
  status: 'ok' | 'warn' | 'bad' | 'unknown'
  note: string
}

/**
 * Пассивная проверка типовых утечек путей: GET по списку известных
 * «чувствительных» путей своего домена и классификация по статусу. Никакого
 * перебора/фаззинга — фиксированный короткий белый список для харденинга.
 */
export interface PathLeak {
  path: string
  status: number | null
  /** Насколько находка критична. */
  severity: 'critical' | 'warn' | 'info'
  /** Найден ли путь (доступен наружу). */
  exposed: boolean
}

/**
 * Почтовая/DNS-гигиена домена: наличие SPF, DMARC, DKIM и CAA-записей.
 * Обычные публичные DNS-запросы (TXT/CAA) — защита от спуфинга и mis-issuance.
 */
export interface DnsHygiene {
  tested: boolean
  spf: boolean
  dmarc: boolean
  /** Политика DMARC (none/quarantine/reject), если найдена. */
  dmarcPolicy: string | null
  /** Найден ли DKIM хотя бы по одному распространённому селектору. */
  dkim: boolean
  caa: boolean
}

/** Разбор силы политики CSP (не только факт наличия). */
export interface CspAnalysis {
  present: boolean
  /** Есть 'unsafe-inline' в script-src/default-src — сводит на нет защиту от XSS. */
  unsafeInline: boolean
  /** Есть 'unsafe-eval'. */
  unsafeEval: boolean
  /** Источник со звёздочкой (`*`) в script-src/default-src. */
  wildcard: boolean
  /** Задан object-src 'none' (блокирует легаси-плагины). */
  objectNone: boolean
  /** Задан frame-ancestors (защита от кликджекинга через CSP). */
  frameAncestors: boolean
  strength: 'none' | 'weak' | 'moderate' | 'strong'
  note: string
}

/** Разбор силы политики HSTS (max-age/includeSubDomains/preload). */
export interface HstsAnalysis {
  present: boolean
  /** Значение max-age в секундах, если распарсено. */
  maxAge: number | null
  includeSubDomains: boolean
  preload: boolean
  strength: 'none' | 'weak' | 'moderate' | 'strong'
  note: string
}

/** Проверка CORS-мисконфигурации (ACAO/ACAC при подставном Origin). */
export interface CorsCheck {
  tested: boolean
  /** Значение Access-Control-Allow-Origin в ответе. */
  acao: string | null
  /** Access-Control-Allow-Credentials: true. */
  acac: boolean
  /** Сервер отражает переданный нами Origin обратно. */
  reflectsOrigin: boolean
  /** ACAO: * (любой источник). */
  wildcard: boolean
  risk: 'none' | 'low' | 'medium' | 'high'
  note: string
}

/** Проверка разрешённых HTTP-методов (OPTIONS/Allow + TRACE). */
export interface MethodsCheck {
  tested: boolean
  /** Методы из заголовка Allow / Access-Control-Allow-Methods. */
  allow: string[]
  /** Потенциально опасные из разрешённых (PUT/DELETE/TRACE/CONNECT/PATCH). */
  dangerous: string[]
  /** TRACE включён (риск Cross-Site Tracing). */
  traceEnabled: boolean
  note: string
}

/** Проверка mixed content: http-ресурсы на https-странице. */
export interface MixedContentCheck {
  tested: boolean
  count: number
  /** Несколько примеров http-URL (для наглядности). */
  samples: string[]
  note: string
}

/** Определение CDN/WAF и анализ заголовков кэша. */
export interface InfraCheck {
  cdn: string | null
  waf: string | null
  server: string | null
  cacheControl: string | null
  /** Приватный ответ (с cookie) помечен публично кэшируемым — риск утечки. */
  privateCacheable: boolean
  note: string
}

export interface SecurityAudit {
  url: string
  host: string
  finalUrl: string
  status: number | null
  /** Ответил ли хост вообще (иначе проверки НЕ выполнялись — не «провалены»). */
  responded: boolean
  scheme: string
  /** Редиректит ли http:// на https:// ('yes' | 'no' | 'unknown'). */
  httpsUpgrade: 'yes' | 'no' | 'unknown'
  securityHeaders: HeaderCheck[]
  disclosure: HeaderCheck[]
  cookies: CookieFlags[]
  /** Cookie, нарушающие соглашения префиксов __Host-/__Secure-. */
  cookiePrefixIssues: string[]
  /** Пассивная проверка отражения ввода (риск reflected XSS). */
  reflection: ReflectionCheck
  /** Разбор силы CSP. */
  csp: CspAnalysis
  /** Разбор силы HSTS. */
  hsts: HstsAnalysis
  /** CORS-мисконфигурация. */
  cors: CorsCheck
  /** Разрешённые HTTP-методы. */
  methods: MethodsCheck
  /** Mixed content на https-странице. */
  mixedContent: MixedContentCheck
  /** CDN/WAF и заголовки кэша. */
  infra: InfraCheck
  /** Проверка TLS-сертификата (только https). */
  tls: TlsCheck
  /** Типовые утечки путей (пустой массив, пока не запрошено отдельно). */
  pathLeaks: PathLeak[]
  /** Проверялись ли пути (ленивая проверка по кнопке, отдельным экшеном). */
  pathLeaksChecked: boolean
  /** Почтовая/DNS-гигиена домена. */
  dns: DnsHygiene
  /** Сводная оценка защищённости. */
  score: SecurityScore
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

/** Пустые (не выполненные) под-проверки — для ветки «хост не ответил». */
function untestedChecks() {
  return {
    reflection: {
      tested: false,
      reflected: false,
      rawSpecials: false,
      headerReflected: false,
      cspPresent: false,
      risk: 'none',
      note: 'Проверка не выполнена — хост не ответил.',
    } as ReflectionCheck,
    tls: {
      tested: false,
      protocol: null,
      issuer: null,
      validTo: null,
      daysLeft: null,
      hostnameMatch: false,
      authorized: false,
      status: 'unknown',
      note: 'Проверка не выполнена — хост не ответил.',
    } as TlsCheck,
    dns: {
      tested: false,
      spf: false,
      dmarc: false,
      dmarcPolicy: null,
      dkim: false,
      caa: false,
    } as DnsHygiene,
    csp: {
      present: false,
      unsafeInline: false,
      unsafeEval: false,
      wildcard: false,
      objectNone: false,
      frameAncestors: false,
      strength: 'none',
      note: 'Проверка не выполнена — хост не ответил.',
    } as CspAnalysis,
    hsts: {
      present: false,
      maxAge: null,
      includeSubDomains: false,
      preload: false,
      strength: 'none',
      note: 'Проверка не выполнена — хост не ответил.',
    } as HstsAnalysis,
    cors: {
      tested: false,
      acao: null,
      acac: false,
      reflectsOrigin: false,
      wildcard: false,
      risk: 'none',
      note: 'Проверка не выполнена — хост не ответил.',
    } as CorsCheck,
    methods: {
      tested: false,
      allow: [],
      dangerous: [],
      traceEnabled: false,
      note: 'Проверка не выполнена — хост не ответил.',
    } as MethodsCheck,
    mixedContent: {
      tested: false,
      count: 0,
      samples: [],
      note: 'Проверка не выполнена — хост не ответил.',
    } as MixedContentCheck,
    infra: {
      cdn: null,
      waf: null,
      server: null,
      cacheControl: null,
      privateCacheable: false,
      note: 'Проверка не выполнена — хост не ответил.',
    } as InfraCheck,
  }
}

/** Собрать пассивный аудит по URL. Вызывается только из гейт-экшена. */
async function collectAudit(url: URL): Promise<SecurityAudit> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const started = performance.now()
  try {
    // SSRF-safe: следим за редиректами вручную, проверяя каждый переход.
    const { res, finalUrl } = await guardedFetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'user-agent': BROWSER_UA },
    })
    const latencyMs = Math.round(performance.now() - started)

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
    const cspValue =
      securityHeaders.find((h) => h.key === 'content-security-policy')?.value ??
      null
    const hstsValue =
      securityHeaders.find((h) => h.key === 'strict-transport-security')
        ?.value ?? null
    const cspPresent = cspValue !== null
    const disclosure = readHeaders(DISCLOSURE_HEADER_KEYS).filter(
      (h) => h.present,
    )

    // Синхронный разбор из уже полученных заголовков (без сетевых запросов).
    const csp = analyzeCsp(cspValue)
    const hsts = analyzeHsts(hstsValue, finalUrl.protocol === 'https:')
    const cookiePrefixIssues = cookiePrefixProblems(cookies)
    const infra = detectInfra(res.headers, cookies)

    // Читаем тело (с ограничением) для проверки mixed content — только для HTML.
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
    const isHtmlResp =
      contentType.includes('text/html') || contentType.includes('xhtml')
    let bodyForScan = ''
    if (isHtmlResp) {
      bodyForScan = await readCapped(res, 262_144)
    } else {
      void res.body?.cancel()
    }
    const mixedContent = scanMixedContent(
      bodyForScan,
      finalUrl.protocol === 'https:',
      isHtmlResp,
    )

    // Дополнительные проверки, требующие сети — параллельно. Утечки путей НЕ
    // включаем: это 10+ отдельных GET, они выполняются отдельным экшеном.
    const [httpsUpgrade, reflection, tls, dns, cors, methods] =
      await Promise.all([
        checkHttpsUpgrade(url),
        checkReflection(url, cspPresent),
        checkTls(finalUrl),
        checkDnsHygiene(url.hostname),
        checkCors(finalUrl),
        checkMethods(finalUrl),
      ])

    const audit: SecurityAudit = {
      url: url.toString(),
      host: url.hostname,
      finalUrl: finalUrl.toString(),
      status: res.status,
      responded: true,
      scheme: finalUrl.protocol.replace(':', ''),
      httpsUpgrade,
      securityHeaders,
      disclosure,
      cookies,
      cookiePrefixIssues,
      reflection,
      csp,
      hsts,
      cors,
      methods,
      mixedContent,
      infra,
      tls,
      pathLeaks: [],
      pathLeaksChecked: false,
      dns,
      score: { value: 0, grade: 'F', deductions: [] },
      latencyMs,
      error: null,
    }
    audit.score = computeScore(audit)
    return audit
  } catch (err) {
    const aborted =
      err instanceof Error &&
      (err.name === 'AbortError' || err.name === 'TimeoutError')
    const u = untestedChecks()
    return {
      url: url.toString(),
      host: url.hostname,
      finalUrl: url.toString(),
      status: null,
      responded: false,
      scheme: url.protocol.replace(':', ''),
      httpsUpgrade: 'unknown',
      securityHeaders: SECURITY_HEADER_KEYS.map((key) => ({
        key,
        present: false,
        value: null,
      })),
      disclosure: [],
      cookies: [],
      cookiePrefixIssues: [],
      reflection: u.reflection,
      csp: u.csp,
      hsts: u.hsts,
      cors: u.cors,
      methods: u.methods,
      mixedContent: u.mixedContent,
      infra: u.infra,
      tls: u.tls,
      pathLeaks: [],
      pathLeaksChecked: false,
      dns: u.dns,
      score: computeScore({
        responded: false,
        scheme: url.protocol.replace(':', ''),
        httpsUpgrade: 'unknown',
        securityHeaders: [],
        disclosure: [],
        reflection: { risk: 'none' },
        tls: { tested: false, status: 'unknown', note: '' },
        pathLeaks: [],
        cookies: [],
        cookiePrefixIssues: [],
        csp: u.csp,
        hsts: u.hsts,
        cors: u.cors,
        methods: u.methods,
        mixedContent: u.mixedContent,
        dns: u.dns,
      }),
      latencyMs: null,
      error: aborted ? 'Таймаут' : 'Нет соединения',
    }
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------- Разбор CSP / HSTS (sync) --------------------- */

/** Разобрать директивы CSP в мапу. */
function parseCspDirectives(value: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const part of value.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (!tokens.length) continue
    const name = tokens[0].toLowerCase()
    map.set(name, tokens.slice(1))
  }
  return map
}

/** Оценить силу политики CSP по её содержимому, а не только наличию. */
function analyzeCsp(value: string | null): CspAnalysis {
  if (!value) {
    return {
      present: false,
      unsafeInline: false,
      unsafeEval: false,
      wildcard: false,
      objectNone: false,
      frameAncestors: false,
      strength: 'none',
      note: 'Content-Security-Policy отсутствует — нет защиты от инъекций на уровне браузера.',
    }
  }
  const dir = parseCspDirectives(value)
  const scriptSrc = dir.get('script-src') ?? dir.get('default-src') ?? []
  const lc = scriptSrc.map((s) => s.toLowerCase())
  const unsafeInline = lc.includes("'unsafe-inline'")
  const unsafeEval = lc.includes("'unsafe-eval'")
  const wildcard = lc.includes('*') || lc.includes('http:') || lc.includes('https:')
  const objectNone = (dir.get('object-src') ?? []).some(
    (s) => s.toLowerCase() === "'none'",
  )
  const frameAncestors = dir.has('frame-ancestors')

  let strength: CspAnalysis['strength'] = 'strong'
  const problems: string[] = []
  if (unsafeInline) problems.push("'unsafe-inline' в скриптах")
  if (unsafeEval) problems.push("'unsafe-eval'")
  if (wildcard) problems.push('источник со звёздочкой (*)')
  if (!scriptSrc.length) problems.push('не задан script-src/default-src')

  if (unsafeInline || wildcard || !scriptSrc.length) strength = 'weak'
  else if (unsafeEval || !frameAncestors) strength = 'moderate'

  const note =
    problems.length > 0
      ? `CSP присутствует, но ослаблена: ${problems.join(', ')}.`
      : 'CSP присутствует и выглядит строгой.'
  return {
    present: true,
    unsafeInline,
    unsafeEval,
    wildcard,
    objectNone,
    frameAncestors,
    strength,
    note,
  }
}

/** Оценить силу политики HSTS: max-age, includeSubDomains, preload. */
function analyzeHsts(value: string | null, isHttps: boolean): HstsAnalysis {
  if (!value) {
    return {
      present: false,
      maxAge: null,
      includeSubDomains: false,
      preload: false,
      strength: 'none',
      note: isHttps
        ? 'HSTS отсутствует — возможен downgrade/SSL-stripping при первом заходе.'
        : 'HSTS неприменим без HTTPS.',
    }
  }
  const lc = value.toLowerCase()
  const m = lc.match(/max-age\s*=\s*(\d+)/)
  const maxAge = m ? Number(m[1]) : null
  const includeSubDomains = lc.includes('includesubdomains')
  const preload = lc.includes('preload')

  let strength: HstsAnalysis['strength'] = 'strong'
  const notes: string[] = []
  if (maxAge === null || maxAge === 0) {
    strength = 'weak'
    notes.push('max-age не задан или равен 0')
  } else if (maxAge < 15_552_000) {
    strength = 'moderate'
    notes.push('max-age меньше рекомендованных 180 дней')
  }
  if (!includeSubDomains && strength !== 'weak') {
    strength = strength === 'strong' ? 'moderate' : strength
    notes.push('нет includeSubDomains')
  }
  const note =
    notes.length > 0
      ? `HSTS присутствует, но: ${notes.join(', ')}.`
      : 'HSTS присутствует с хорошим max-age.'
  return { present: true, maxAge, includeSubDomains, preload, strength, note }
}

/** Cookie, нарушающие соглашения префиксов __Host-/__Secure-. */
function cookiePrefixProblems(cookies: CookieFlags[]): string[] {
  const issues: string[] = []
  for (const c of cookies) {
    const name = c.name
    if (name.startsWith('__Host-')) {
      if (!c.secure) issues.push(`${name}: префикс __Host- требует Secure`)
    } else if (name.startsWith('__Secure-')) {
      if (!c.secure) issues.push(`${name}: префикс __Secure- требует Secure`)
    }
  }
  return issues
}

/** Определить CDN/WAF по характерным заголовкам и разобрать кэш. */
function detectInfra(headers: Headers, cookies: CookieFlags[]): InfraCheck {
  const has = (k: string) => headers.get(k) !== null
  const server = headers.get('server')
  let cdn: string | null = null
  let waf: string | null = null

  if (has('cf-ray') || /cloudflare/i.test(server ?? '')) {
    cdn = 'Cloudflare'
    if (has('cf-mitigated') || has('cf-ray')) waf = 'Cloudflare'
  } else if (has('x-vercel-id') || /vercel/i.test(server ?? '')) {
    cdn = 'Vercel'
  } else if (has('x-amz-cf-id') || /cloudfront/i.test(headers.get('via') ?? '')) {
    cdn = 'Amazon CloudFront'
  } else if (has('x-served-by') || has('x-fastly-request-id') || /fastly/i.test(server ?? '')) {
    cdn = 'Fastly'
  } else if (has('x-akamai-transformed') || /akamai/i.test(server ?? '')) {
    cdn = 'Akamai'
  } else if (/sucuri/i.test(server ?? '') || has('x-sucuri-id')) {
    waf = 'Sucuri'
  } else if (has('x-amzn-waf-action')) {
    waf = 'AWS WAF'
  }

  const cacheControl = headers.get('cache-control')
  const lc = (cacheControl ?? '').toLowerCase()
  const setsCookies = cookies.length > 0
  // Ответ с cookie, помеченный публично кэшируемым, может утечь между клиентами.
  const publiclyCacheable =
    lc.includes('public') ||
    (/s-maxage=\d+/.test(lc) && !lc.includes('private') && !lc.includes('no-store'))
  const privateCacheable = setsCookies && publiclyCacheable

  const parts: string[] = []
  if (cdn) parts.push(`CDN: ${cdn}`)
  if (waf) parts.push(`WAF: ${waf}`)
  if (!cdn && !waf) parts.push('CDN/WAF по заголовкам не определён')
  if (privateCacheable)
    parts.push('ответ с cookie помечен публично кэшируемым — риск утечки')

  return {
    cdn,
    waf,
    server,
    cacheControl,
    privateCacheable,
    note: parts.join('; ') + '.',
  }
}

/** Найти http-ресурсы (mixed content) на https-странице. */
function scanMixedContent(
  body: string,
  isHttps: boolean,
  isHtml: boolean,
): MixedContentCheck {
  if (!isHttps || !isHtml || !body) {
    return {
      tested: isHttps && isHtml,
      count: 0,
      samples: [],
      note: !isHttps
        ? 'Страница не по HTTPS — mixed content неприменим.'
        : !isHtml
          ? 'Ответ не HTML — проверка mixed content неприменима.'
          : 'Mixed content не обнаружен.',
    }
  }
  const re = /(?:src|href|action)\s*=\s*["'](http:\/\/[^"']+)["']/gi
  const samples: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  let count = 0
  while ((m = re.exec(body)) && count < 200) {
    const u = m[1]
    // http://schema.org и подобные пространства имён — не загрузка ресурса.
    if (/^http:\/\/(www\.)?w3\.org|^http:\/\/schema\.org/i.test(u)) continue
    count++
    if (samples.length < 5 && !seen.has(u)) {
      seen.add(u)
      samples.push(u)
    }
  }
  return {
    tested: true,
    count,
    samples,
    note:
      count > 0
        ? `Найдено http-ресурсов на https-странице: ${count}.`
        : 'Mixed content не обнаружен.',
  }
}

/**
 * CORS-проверка: шлём запрос с подставным Origin и смотрим, отражает ли сервер
 * его в Access-Control-Allow-Origin и разрешает ли credentials. Отражение
 * произвольного Origin вместе с ACAC:true — классическая опасная мисконфигурация.
 */
async function checkCors(finalUrl: URL): Promise<CorsCheck> {
  const probeOrigin = 'https://od-cors-probe.example'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(finalUrl, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'user-agent': BROWSER_UA, origin: probeOrigin },
    })
    void res.body?.cancel()
    const acao = res.headers.get('access-control-allow-origin')
    const acac =
      (res.headers.get('access-control-allow-credentials') ?? '').toLowerCase() ===
      'true'
    const wildcard = acao === '*'
    const reflectsOrigin = acao === probeOrigin

    let risk: CorsCheck['risk'] = 'none'
    let note = 'CORS не отражает произвольный источник — безопасно.'
    if (reflectsOrigin && acac) {
      risk = 'high'
      note =
        'Сервер отражает произвольный Origin И разрешает credentials — критичная CORS-мисконфигурация (кража данных с аутентификацией).'
    } else if (reflectsOrigin) {
      risk = 'medium'
      note =
        'Сервер отражает произвольный Origin в ACAO — потенциальная утечка данных для сторонних сайтов.'
    } else if (wildcard && acac) {
      risk = 'medium'
      note = 'ACAO:* вместе с credentials — спецификация это игнорирует, но конфигурация ошибочна.'
    } else if (wildcard) {
      risk = 'low'
      note = 'ACAO:* — открытый доступ к ответам (ок для публичного API, риск для приватного).'
    }
    return { tested: true, acao, acac, reflectsOrigin, wildcard, risk, note }
  } catch {
    return {
      tested: false,
      acao: null,
      acac: false,
      reflectsOrigin: false,
      wildcard: false,
      risk: 'none',
      note: 'CORS-проверку выполнить не удалось.',
    }
  } finally {
    clearTimeout(timer)
  }
}

const DANGEROUS_METHODS = ['PUT', 'DELETE', 'TRACE', 'CONNECT', 'PATCH']

/** Проверка разрешённых HTTP-методов через OPTIONS (+ детект TRACE). */
async function checkMethods(finalUrl: URL): Promise<MethodsCheck> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(finalUrl, {
      method: 'OPTIONS',
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'user-agent': BROWSER_UA },
    })
    void res.body?.cancel()
    const allowRaw =
      res.headers.get('allow') ??
      res.headers.get('access-control-allow-methods') ??
      ''
    const allow = allowRaw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
    const dangerous = allow.filter((m) => DANGEROUS_METHODS.includes(m))
    const traceEnabled = allow.includes('TRACE')
    const note = allow.length
      ? dangerous.length
        ? `Разрешены потенциально опасные методы: ${dangerous.join(', ')}.`
        : 'Опасных методов среди разрешённых не обнаружено.'
      : 'Сервер не сообщил список методов (заголовок Allow пуст).'
    return { tested: true, allow, dangerous, traceEnabled, note }
  } catch {
    return {
      tested: false,
      allow: [],
      dangerous: [],
      traceEnabled: false,
      note: 'Проверку методов выполнить не удалось.',
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
      headers: { 'user-agent': BROWSER_UA },
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
    const { res } = await guardedFetch(probeUrl, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'user-agent': BROWSER_UA,
        // Второй контекст: маркер в заголовке-подсказке (без спецсимволов —
        // многие серверы отвергают их), чтобы поймать отражение в ответ.
        'x-od-probe': core,
      },
    })

    // Отражение в заголовках ответа — риск header injection / XSS через заголовок.
    let headerReflected = false
    res.headers.forEach((v) => {
      if (v.includes(core)) headerReflected = true
    })

    // Проверяем отражение в теле только для HTML — в JSON/бинарнике это не про XSS.
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
        headerReflected,
        cspPresent,
        risk: headerReflected ? 'medium' : 'none',
        note: headerReflected
          ? 'Ответ не HTML, но ввод отражается в заголовке ответа — проверьте фильтрацию.'
          : 'Ответ не HTML — отражение ввода в разметку неприменимо.',
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
    if (headerReflected && (risk === 'none' || risk === 'low')) {
      // Отражение в заголовке — поднимаем минимум до среднего риска.
      risk = 'medium'
      note += ' Кроме того, ввод отражается в заголовке ответа.'
    }

    return {
      tested: true,
      reflected,
      rawSpecials,
      headerReflected,
      cspPresent,
      risk,
      note,
    }
  } catch {
    return {
      tested: false,
      reflected: false,
      rawSpecials: false,
      headerReflected: false,
      cspPresent,
      risk: 'none',
      note: 'Проверку отражения выполнить не удалось.',
    }
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------- Проверка TLS-сертификата --------------------- */

/**
 * Открыть TLS-соединение и прочитать предъявляемый сертификат. Пассивно:
 * согласуем TLS (как браузер), читаем срок/издателя/протокол и закрываем.
 * Только для https-адресов.
 */
function checkTls(finalUrl: URL): Promise<TlsCheck> {
  const unknown: TlsCheck = {
    tested: false,
    protocol: null,
    issuer: null,
    validTo: null,
    daysLeft: null,
    hostnameMatch: false,
    authorized: false,
    status: 'unknown',
    note: 'Проверка TLS не выполнялась.',
  }
  if (finalUrl.protocol !== 'https:') {
    return Promise.resolve({
      ...unknown,
      note: 'Соединение без HTTPS — TLS-сертификат отсутствует.',
    })
  }

  const host = finalUrl.hostname
  const port = finalUrl.port ? Number(finalUrl.port) : 443

  return new Promise<TlsCheck>((resolve) => {
    let settled = false
    const done = (r: TlsCheck) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* уже закрыт */
      }
      resolve(r)
    }

    // rejectUnauthorized:false — мы САМИ оцениваем доверие, чтобы прочитать
    // сертификат даже у просроченных/самоподписанных (для диагностики).
    const socket = tlsConnect(
      { host, port, servername: host, rejectUnauthorized: false, ALPNProtocols: ['h2', 'http/1.1'] },
      () => {
        const cert = socket.getPeerCertificate()
        const protocol = socket.getProtocol()
        const authorized = socket.authorized
        done(evaluateCert(cert, protocol, authorized, host))
      },
    )
    socket.setTimeout(TIMEOUT_MS, () =>
      done({ ...unknown, note: 'Таймаут TLS-соединения.' }),
    )
    socket.on('error', () =>
      done({ ...unknown, note: 'Не удалось установить TLS-соединение.' }),
    )
  })
}

/** Оценить прочитанный сертификат: срок, издатель, протокол, доверие. */
function evaluateCert(
  cert: PeerCertificate | Record<string, never>,
  protocol: string | null,
  authorized: boolean,
  host: string,
): TlsCheck {
  const validTo =
    cert && 'valid_to' in cert && cert.valid_to
      ? new Date(cert.valid_to)
      : null
  const validToIso =
    validTo && !Number.isNaN(validTo.getTime()) ? validTo.toISOString() : null
  const daysLeft = validTo
    ? Math.round((validTo.getTime() - Date.now()) / 86_400_000)
    : null
  const issuer =
    cert && 'issuer' in cert && cert.issuer
      ? cert.issuer.O ?? cert.issuer.CN ?? null
      : null
  const hostnameMatch = certMatchesHost(cert, host)

  let status: TlsCheck['status'] = 'ok'
  let note = 'Сертификат действителен.'
  // TLSv1, TLSv1.0, TLSv1.1 — устаревшие; TLSv1.2/1.3 регэксп не матчит.
  const weakProto = protocol !== null && /^TLSv1(\.[01])?$/.test(protocol)

  if (daysLeft !== null && daysLeft < 0) {
    status = 'bad'
    note = 'Сертификат просрочен.'
  } else if (!authorized || !hostnameMatch) {
    status = 'bad'
    note = !hostnameMatch
      ? 'Имя хоста не совпадает с сертификатом.'
      : 'Цепочка сертификата не доверенная (самоподписан или неизвестный CA).'
  } else if (daysLeft !== null && daysLeft <= 14) {
    status = 'warn'
    note = `Сертификат истекает через ${daysLeft} дн. — пора обновить.`
  } else if (weakProto) {
    status = 'warn'
    note = `Согласован устаревший протокол ${protocol}. Рекомендуется TLS 1.2+.`
  }

  return {
    tested: true,
    protocol,
    issuer,
    validTo: validToIso,
    daysLeft,
    hostnameMatch,
    authorized,
    status,
    note,
  }
}

/**
 * Совпадает ли хост с сертификатом. Основной путь — штатный
 * `tls.checkServerIdentity` (корректно учитывает SAN без Subject, wildcard,
 * IP-SAN). Ручной разбор SAN/CN — только запасной вариант на случай, если
 * стандартная проверка бросит исключение на нетипичном сертификате.
 */
function certMatchesHost(
  cert: PeerCertificate | Record<string, never>,
  host: string,
): boolean {
  if (!cert || typeof cert !== 'object' || Object.keys(cert).length === 0) {
    return false
  }
  try {
    // undefined — имя валидно; Error — не совпало.
    return checkServerIdentity(host, cert as PeerCertificate) === undefined
  } catch {
    // Запасной ручной матчинг: SAN проверяется НЕЗАВИСИМО от наличия Subject.
    const names = new Set<string>()
    const subject = 'subject' in cert ? cert.subject : undefined
    if (subject?.CN) names.add(subject.CN.toLowerCase())
    const san = 'subjectaltname' in cert ? cert.subjectaltname : undefined
    if (san) {
      for (const entry of san.split(',')) {
        const m = entry.trim().match(/^DNS:(.+)$/i)
        if (m) names.add(m[1].toLowerCase())
      }
    }
    const h = host.toLowerCase()
    for (const name of names) {
      if (name === h) return true
      if (name.startsWith('*.')) {
        const base = name.slice(2)
        const idx = h.indexOf('.')
        if (idx > -1 && h.slice(idx + 1) === base) return true
      }
    }
    return false
  }
}

/* ------------------------- Утечки типовых путей ------------------------- */

/**
 * Определение чувствительного пути. `confirm` подтверждает, что 200 — это
 * действительно файл, а не catch-all/SPA-заглушка (которая отдаёт index.html
 * с кодом 200 на любой путь). Без такой проверки любой SPA ложно «светил»
 * открытыми .env/.git/бэкапами. Для info-путей (security.txt) подтверждение не
 * требуется — там сам факт наличия и есть ожидаемый результат.
 */
type SensitivePath = {
  path: string
  severity: PathLeak['severity']
  confirm?: (body: string, contentType: string) => boolean
}

const isHtml = (ct: string) => ct.includes('text/html') || ct.includes('xhtml')

const SENSITIVE_PATHS: SensitivePath[] = [
  {
    path: '/.env',
    severity: 'critical',
    // Реальный .env — не HTML и содержит строки вида KEY=VALUE.
    confirm: (b, ct) => !isHtml(ct) && /^[A-Za-z_][A-Za-z0-9_.]*\s*=/m.test(b),
  },
  {
    path: '/.git/config',
    severity: 'critical',
    confirm: (b, ct) => !isHtml(ct) && /\[core\]/i.test(b),
  },
  {
    path: '/.git/HEAD',
    severity: 'critical',
    confirm: (b, ct) =>
      !isHtml(ct) && (/^ref:\s/m.test(b) || /^[0-9a-f]{40}\b/m.test(b)),
  },
  {
    path: '/config.json',
    severity: 'warn',
    confirm: (b, ct) => ct.includes('json') || /^\s*[{[]/.test(b),
  },
  {
    path: '/backup.zip',
    severity: 'warn',
    confirm: (b, ct) =>
      ct.includes('zip') || ct.includes('octet-stream') || b.startsWith('PK'),
  },
  { path: '/.well-known/security.txt', severity: 'info' },
  { path: '/robots.txt', severity: 'info', confirm: (b, ct) => !isHtml(ct) },
  {
    path: '/sitemap.xml',
    severity: 'info',
    confirm: (b, ct) => ct.includes('xml') || /<urlset|<sitemapindex/i.test(b),
  },
  {
    path: '/server-status',
    severity: 'warn',
    confirm: (b) => /Apache Server Status|Server uptime|Total accesses/i.test(b),
  },
  {
    path: '/phpinfo.php',
    severity: 'warn',
    confirm: (b) => /phpinfo\(\)|PHP Version|php_uname/i.test(b),
  },
  {
    // Spring Boot Actuator — открытый наружу набор диагностических эндпоинтов.
    path: '/actuator',
    severity: 'warn',
    confirm: (b, ct) =>
      (ct.includes('json') || /^\s*\{/.test(b)) &&
      (/"_links"/.test(b) || /"status"\s*:\s*"UP"/.test(b)),
  },
]

/**
 * Проверить типовые «утечки» по фиксированному списку. Для каждого пути —
 * один GET; 200 засчитывается как утечка только если `confirm` подтверждает
 * содержимое (защита от catch-all/SPA, отдающих 200 на любой путь). Объём тела
 * ограничен.
 */
async function checkPathLeaks(finalUrl: URL): Promise<PathLeak[]> {
  const origin = `${finalUrl.protocol}//${finalUrl.host}`
  const results = await Promise.all(
    SENSITIVE_PATHS.map(async ({ path, severity, confirm }) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        const res = await fetch(`${origin}${path}`, {
          method: 'GET',
          redirect: 'manual',
          cache: 'no-store',
          signal: controller.signal,
          headers: { 'user-agent': BROWSER_UA },
        })
        const ok200 = res.status === 200
        let exposed = ok200
        if (ok200 && confirm) {
          const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
          const body = await readCapped(res, 8192)
          exposed = confirm(body, contentType)
        } else {
          void res.body?.cancel()
        }
        return { path, status: res.status, severity, exposed }
      } catch {
        return { path, status: null, severity, exposed: false }
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  return results
}

export interface PathLeaksActionResult {
  ok: boolean
  message: string
  data?: PathLeak[]
}

/**
 * Ленивая проверка типовых утечек путей (по кнопке в UI). Вынесена из общего
 * аудита, потому что это 10+ отдельных GET. Гейт requireGod, SSRF-guard,
 * только чтение публичного ответа. Итоговый URL определяется одним запросом,
 * чтобы учесть редиректы (http→https, www).
 */
export async function secretPathLeaksAction(
  rawUrl: string,
): Promise<PathLeaksActionResult> {
  await requireGod()
  const url = normalizeUrl(rawUrl)
  if (!url) {
    return {
      ok: false,
      message: 'Некорректный адрес. Введите домен или http(s)-URL.',
    }
  }
  const blocked = await guardPublicHost(url.hostname)
  if (blocked) return { ok: false, message: blocked }

  // Определяем финальный URL (после редиректов), чтобы пути били по нужному хосту.
  let finalUrl = url
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const { res, finalUrl: fin } = await guardedFetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'user-agent': BROWSER_UA },
    })
    void res.body?.cancel()
    finalUrl = fin
  } catch {
    return { ok: false, message: 'Хост не ответил — пути не проверены.' }
  } finally {
    clearTimeout(timer)
  }

  const leaks = await checkPathLeaks(finalUrl)
  return { ok: true, message: 'Готово', data: leaks }
}

/* ------------------------- DNS / почтовая гигиена ----------------------- */

/** Распространённые DKIM-селекторы для best-effort проверки. */
const DKIM_SELECTORS = ['default', 'google', 'selector1', 'selector2', 'k1', 'mail', 's1']

/**
 * Составные публичные суффиксы (мини-PSL). Нужны, чтобы для `sub.example.co.uk`
 * получить регистрируемый домен `example.co.uk`, а не `co.uk`.
 */
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'ltd.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'com.br', 'com.mx',
  'co.jp', 'com.tr', 'com.ua', 'co.il', 'com.sg', 'com.cn',
  'co.kr', 'co.in', 'com.hk', 'co.za', 'com.pl', 'com.ru',
])

/**
 * Регистрируемый домен (eTLD+1). SPF/DMARC/CAA публикуются, как правило, на
 * нём, а не на поддомене — поэтому проверять надо именно его, иначе для
 * `app.example.com` мы ложно рапортовали «нет SPF/DMARC».
 */
function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  const lastTwo = labels.slice(-2).join('.')
  if (MULTI_PART_TLDS.has(lastTwo)) return labels.slice(-3).join('.')
  return lastTwo
}

/** Собрать флаги SPF/DMARC/DKIM/CAA через публичные DNS-запросы. */
async function checkDnsHygiene(host: string): Promise<DnsHygiene> {
  const org = registrableDomain(host)

  const [spf, dmarcInfo, dkim, caa] = await Promise.all([
    hasSpf(org),
    // DMARC ищем сперва на самом хосте, затем — на org-домене (наследование).
    getDmarcWithFallback(host, org),
    hasDkim(org),
    hasCaa(org),
  ])

  return {
    tested: true,
    spf,
    dmarc: dmarcInfo.present,
    dmarcPolicy: dmarcInfo.policy,
    dkim,
    caa,
  }
}

/** DMARC: сначала точный хост, потом org-домен (получатели резолвят по нему). */
async function getDmarcWithFallback(
  host: string,
  org: string,
): Promise<{ present: boolean; policy: string | null }> {
  const primary = await getDmarc(host)
  if (primary.present || org === host) return primary
  return getDmarc(org)
}

async function hasSpf(domain: string): Promise<boolean> {
  try {
    const records = await resolveTxt(domain)
    return records.some((chunks) =>
      chunks.join('').toLowerCase().startsWith('v=spf1'),
    )
  } catch {
    return false
  }
}

async function getDmarc(
  domain: string,
): Promise<{ present: boolean; policy: string | null }> {
  try {
    const records = await resolveTxt(`_dmarc.${domain}`)
    const joined = records.map((c) => c.join('')).find((t) =>
      t.toLowerCase().startsWith('v=dmarc1'),
    )
    if (!joined) return { present: false, policy: null }
    const m = joined.toLowerCase().match(/p=([a-z]+)/)
    return { present: true, policy: m ? m[1] : null }
  } catch {
    return { present: false, policy: null }
  }
}

async function hasDkim(domain: string): Promise<boolean> {
  const checks = await Promise.all(
    DKIM_SELECTORS.map(async (sel) => {
      try {
        const records = await resolveTxt(`${sel}._domainkey.${domain}`)
        return records.some((c) => c.join('').toLowerCase().includes('v=dkim1'))
      } catch {
        return false
      }
    }),
  )
  return checks.some(Boolean)
}

async function hasCaa(domain: string): Promise<boolean> {
  try {
    const records = await resolveCaa(domain)
    return records.length > 0
  } catch {
    return false
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
  const blocked = await guardPublicHost(url.hostname)
  if (blocked) return { ok: false, message: blocked }
  const data = await collectAudit(url)
  if (data.error && data.status === null) {
    return { ok: false, message: `Хост не ответил: ${data.error}`, data }
  }
  return { ok: true, message: 'Готово', data }
}

/* ------------------------- AI-заключение (харденинг) --------------------- */

// Мягкий rate-limit на дорогие вызовы модели: 6 AI-заключений в минуту
// СУММАРНО (assess + drill). In-memory, best-effort — панель однопроцессная.
const aiCallTimestamps: number[] = []

/** Проверить и зарезервировать слот AI-вызова. true — можно, false — перебор. */
function reserveAiSlot(limit = 6, windowMs = 60_000): boolean {
  const now = Date.now()
  while (aiCallTimestamps.length && now - aiCallTimestamps[0] > windowMs) {
    aiCallTimestamps.shift()
  }
  if (aiCallTimestamps.length >= limit) return false
  aiCallTimestamps.push(now)
  return true
}

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

  const blocked = await guardPublicHost(url.hostname)
  if (blocked) return { ok: false, message: blocked }

  if (!reserveAiSlot()) {
    return {
      ok: false,
      message: 'Слишком часто. Подождите минуту и попробуйте снова.',
    }
  }

  const audit = await collectAudit(url)
  if (audit.error && audit.status === null) {
    return { ok: false, message: `Хост не ответил: ${audit.error}`, audit }
  }

  // AI-заключение — это «глубокий» проход, поэтому дотягиваем и утечки путей
  // (в обычном аудите они ленивые), затем пересчитываем сводную оценку.
  try {
    const leaks = await checkPathLeaks(new URL(audit.finalUrl))
    audit.pathLeaks = leaks
    audit.pathLeaksChecked = true
    audit.score = computeScore(audit)
  } catch {
    /* пути не критичны для заключения — продолжаем без них */
  }

  // Ленивый импорт: тянет server-only + gateway-пл'юмбинг только при запросе.
  // Аудит собран сервером (не доверяется клиенту), поэтому передаём целиком.
  const { assessSecurity } = await import('@/lib/god-pentest')
  const res = await assessSecurity(audit)

  if (!res.ok) return { ok: false, message: res.message, audit }
  return { ok: true, message: 'Готово', report: res.report, audit }
}

/* ===================================================================== */
/*  Движок «пробива» находок (drill-down верификация)                     */
/*                                                                        */
/*  Когда аудит нашёл слабое место, оператор может «пробить» его — то есть */
/*  провести дополнительные ПОДТВЕРЖДАЮЩИЕ проверки, чтобы понять, это     */
/*  реальная эксплуатируемая проблема или ложная тревога, и получить      */
/*  доказательство. СТРОГО read-only и defensive: только наблюдаем        */
/*  публичные ответы своего домена, НЕ применяем эксплойт-пейлоады, НЕ    */
/*  перебираем, НЕ мутируем данные. Секреты маскируются. Часть скрытой    */
/*  панели: гейт requireGod, без audit() (инвариант AGENTS.md §4).        */
/* ===================================================================== */

/** Виды находок, которые умеет «пробивать» движок. */
export type DrillKind =
  | 'path-leak' // открытый чувствительный путь (.env/.git/бэкап…)
  | 'reflection' // отражение ввода (reflected XSS)
  | 'missing-hsts' // нет HSTS при работающем HTTPS
  | 'no-https-upgrade' // http не редиректит на https
  | 'software-disclosure' // раскрытие версий ПО
  | 'tls' // проблема с сертификатом

/** Один шаг проверки-подтверждения с наблюдаемым результатом. */
export interface DrillStep {
  /** Что именно проверяли. */
  label: string
  /** Наблюдаемый результат (человекочитаемо, секреты замаскированы). */
  detail: string
  /** Итог шага: подтверждает проблему / опровергает / нейтрально. */
  outcome: 'confirmed' | 'refuted' | 'info'
}

export interface DrillResult {
  kind: DrillKind
  /** Заголовок находки, которую пробивали. */
  title: string
  /** Итоговый вердикт: подтверждена ли эксплуатируемость. */
  verdict: 'exploitable' | 'likely' | 'not-exploitable' | 'inconclusive'
  /** Цепочка выполненных проверок. */
  steps: DrillStep[]
  /** Короткое доказательство/выдержка (замаскировано), если есть. */
  evidence: string | null
}

export interface DrillActionResult {
  ok: boolean
  message: string
  data?: DrillResult
  /** AI-заключение по конкретной находке (markdown). */
  report?: string
}

/** Замаскировать похожее на секрет значение, оставив хвост для узнавания. */
function maskSecret(v: string): string {
  const t = v.trim()
  if (t.length <= 8) return '••••'
  return `${t.slice(0, 2)}••••${t.slice(-2)} (${t.length} симв.)`
}

/** Простой GET с наблюдением тела (для подтверждения находки). */
async function probeGet(
  target: string,
  cap = 8192,
): Promise<{ status: number | null; ct: string; body: string; headers: Headers | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(target, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'user-agent': BROWSER_UA },
    })
    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    const body = await readCapped(res, cap)
    return { status: res.status, ct, body, headers: res.headers }
  } catch {
    return { status: null, ct: '', body: '', headers: null }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * «Пробить» конкретную находку: провести подтверждающие read-only проверки.
 * `origin` — базовый origin финального URL; `arg` — контекст находки
 * (например, путь для path-leak).
 */
async function drillFinding(
  kind: DrillKind,
  origin: string,
  arg: string | null,
): Promise<DrillResult> {
  switch (kind) {
    case 'path-leak':
      return drillPathLeak(origin, arg)
    case 'reflection':
      return drillReflection(origin)
    case 'software-disclosure':
      return drillDisclosure(origin)
    case 'missing-hsts':
      return drillMissingHsts(origin)
    case 'no-https-upgrade':
      return drillHttpsUpgrade(origin)
    case 'tls':
      return drillTls(origin)
    default:
      return {
        kind,
        title: 'Неизвестная находка',
        verdict: 'inconclusive',
        steps: [],
        evidence: null,
      }
  }
}

/** Пробив открытого пути: читаем файл, подтверждаем формат, ищем секреты. */
async function drillPathLeak(origin: string, path: string | null): Promise<DrillResult> {
  const steps: DrillStep[] = []
  const p = path ?? '/.env'
  const url = `${origin}${p}`
  const res = await probeGet(url, 16384)

  steps.push({
    label: `GET ${p}`,
    detail:
      res.status === null
        ? 'Хост не ответил'
        : `HTTP ${res.status}, content-type: ${res.ct || 'не указан'}`,
    outcome: res.status === 200 ? 'confirmed' : 'refuted',
  })

  if (res.status !== 200 || !res.body) {
    return {
      kind: 'path-leak',
      title: `Открытый путь ${p}`,
      verdict: 'not-exploitable',
      steps,
      evidence: null,
    }
  }

  const isHtmlBody = res.ct.includes('html') || /^\s*<!doctype html|^\s*<html/i.test(res.body)
  if (isHtmlBody) {
    steps.push({
      label: 'Анализ тела',
      detail: 'Ответ — HTML-страница (вероятно SPA/catch-all), а не файл.',
      outcome: 'refuted',
    })
    return {
      kind: 'path-leak',
      title: `Открытый путь ${p}`,
      verdict: 'not-exploitable',
      steps,
      evidence: null,
    }
  }

  // Ищем признаки реальных секретов в .env-подобном/конфиг-теле.
  const secretHits: string[] = []
  const kvRe = /^([A-Z][A-Z0-9_]{2,})\s*=\s*(.+)$/gm
  let m: RegExpExecArray | null
  let count = 0
  while ((m = kvRe.exec(res.body)) && count < 40) {
    count++
    const key = m[1]
    if (/KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|DSN|DATABASE_URL|PRIVATE/i.test(key)) {
      secretHits.push(`${key}=${maskSecret(m[2])}`)
    }
  }

  const gitLike = /\[core\]|ref:\s|^[0-9a-f]{40}\b/m.test(res.body)

  if (secretHits.length > 0) {
    steps.push({
      label: 'Поиск секретов',
      detail: `Найдены переменные, похожие на секреты: ${secretHits.length} шт. (значения замаскированы).`,
      outcome: 'confirmed',
    })
    return {
      kind: 'path-leak',
      title: `Открытый путь ${p}`,
      verdict: 'exploitable',
      steps,
      evidence: secretHits.slice(0, 8).join('\n'),
    }
  }

  if (gitLike) {
    steps.push({
      label: 'Анализ тела',
      detail: 'Ответ похож на служебный файл git — репозиторий может быть выкачиваемым.',
      outcome: 'confirmed',
    })
    return {
      kind: 'path-leak',
      title: `Открытый путь ${p}`,
      verdict: 'exploitable',
      steps,
      evidence: res.body.slice(0, 300),
    }
  }

  steps.push({
    label: 'Анализ тела',
    detail: 'Путь отдаёт содержимое, но явных секретов не обнаружено.',
    outcome: 'info',
  })
  return {
    kind: 'path-leak',
    title: `Открытый путь ${p}`,
    verdict: 'likely',
    steps,
    evidence: res.body.slice(0, 300),
  }
}

/** Пробив reflected XSS: проверяем маркер и экранирование в разных контекстах. */
async function drillReflection(origin: string): Promise<DrillResult> {
  const steps: DrillStep[] = []
  const marker = `zz${Math.random().toString(36).slice(2, 8)}zz`
  // Безопасный «канареечный» пробник со спецсимволами — НЕ рабочий эксплойт,
  // просто проверяем, экранирует ли сервер < > " при отражении.
  const probe = `${marker}<'">`
  const url = `${origin}/?__od_probe=${encodeURIComponent(probe)}`
  const res = await probeGet(url, 65536)

  steps.push({
    label: 'GET с канареечным параметром',
    detail: res.status === null ? 'Хост не ответил' : `HTTP ${res.status}`,
    outcome: 'info',
  })

  if (res.status === null) {
    return { kind: 'reflection', title: 'Отражение ввода', verdict: 'inconclusive', steps, evidence: null }
  }

  const reflected = res.body.includes(marker)
  steps.push({
    label: 'Поиск маркера в ответе',
    detail: reflected ? 'Маркер найден — ввод отражается в теле ответа.' : 'Маркер не найден — ввод не отражается.',
    outcome: reflected ? 'confirmed' : 'refuted',
  })

  if (!reflected) {
    return { kind: 'reflection', title: 'Отражение ввода', verdict: 'not-exploitable', steps, evidence: null }
  }

  const rawSpecials = res.body.includes(`${marker}<'">`)
  const escaped = res.body.includes('&lt;') || res.body.includes('&gt;') || res.body.includes('&#')
  const inHtmlContext = res.ct.includes('html')

  steps.push({
    label: 'Проверка экранирования',
    detail: rawSpecials
      ? 'Спецсимволы (< > " \') вернулись СЫРЫМИ — экранирование отсутствует.'
      : escaped
        ? 'Спецсимволы экранированы (&lt; / &gt;) — базовая защита есть.'
        : 'Спецсимволы не отражены дословно — контекст неопасен.',
    outcome: rawSpecials ? 'confirmed' : 'refuted',
  })

  let verdict: DrillResult['verdict'] = 'likely'
  if (rawSpecials && inHtmlContext) verdict = 'exploitable'
  else if (!rawSpecials) verdict = 'not-exploitable'

  return {
    kind: 'reflection',
    title: 'Отражение ввода (reflected XSS)',
    verdict,
    steps,
    evidence: rawSpecials ? `Отражено без экранирования: ${marker}<'">` : null,
  }
}

/** Пробив раскрытия ПО: собираем версии из заголовков разных ответов. */
async function drillDisclosure(origin: string): Promise<DrillResult> {
  const steps: DrillStep[] = []
  const res = await probeGet(origin, 1024)
  const found: string[] = []
  if (res.headers) {
    for (const h of ['server', 'x-powered-by', 'x-aspnet-version', 'x-generator']) {
      const v = res.headers.get(h)
      if (v) found.push(`${h}: ${v}`)
    }
  }
  steps.push({
    label: 'Чтение заголовков ответа',
    detail: found.length ? found.join('; ') : 'Заголовки с версиями ПО не обнаружены.',
    outcome: found.length ? 'confirmed' : 'refuted',
  })
  const versioned = found.some((f) => /\d+\.\d+/.test(f))
  if (versioned) {
    steps.push({
      label: 'Оценка риска',
      detail: 'Раскрыты точные версии ПО — упрощает подбор известных уязвимостей под них.',
      outcome: 'confirmed',
    })
  }
  return {
    kind: 'software-disclosure',
    title: 'Раскрытие версий ПО',
    verdict: versioned ? 'likely' : found.length ? 'inconclusive' : 'not-exploitable',
    steps,
    evidence: found.length ? found.join('\n') : null,
  }
}

/** Пробив отсутствия HSTS: подтверждаем, что HTTPS работает, а заголовка нет. */
async function drillMissingHsts(origin: string): Promise<DrillResult> {
  const steps: DrillStep[] = []
  const res = await probeGet(origin, 512)
  const hsts = res.headers?.get('strict-transport-security') ?? null
  steps.push({
    label: 'GET по HTTPS',
    detail: res.status === null ? 'Хост не ответил' : `HTTP ${res.status}`,
    outcome: 'info',
  })
  steps.push({
    label: 'Strict-Transport-Security',
    detail: hsts ? `Заголовок присутствует: ${hsts}` : 'Заголовок отсутствует — возможна атака downgrade/SSL-stripping при первом заходе.',
    outcome: hsts ? 'refuted' : 'confirmed',
  })
  return {
    kind: 'missing-hsts',
    title: 'Отсутствует HSTS',
    verdict: hsts ? 'not-exploitable' : 'likely',
    steps,
    evidence: null,
  }
}

/** Пробив http→https: проверяем, редиректит ли http и не отдаёт ли контент. */
async function drillHttpsUpgrade(origin: string): Promise<DrillResult> {
  const steps: DrillStep[] = []
  let httpUrl: string
  try {
    const u = new URL(origin)
    u.protocol = 'http:'
    if (u.port === '443') u.port = ''
    httpUrl = u.toString()
  } catch {
    return { kind: 'no-https-upgrade', title: 'Нет upgrade на HTTPS', verdict: 'inconclusive', steps, evidence: null }
  }
  const res = await probeGet(httpUrl, 2048)
  const loc = res.headers?.get('location') ?? null
  const redirectsToHttps = res.status !== null && res.status >= 300 && res.status < 400 && !!loc && loc.startsWith('https://')

  steps.push({
    label: `GET ${httpUrl}`,
    detail: res.status === null ? 'http не ответил (возможно, порт 80 закрыт — это ок)' : `HTTP ${res.status}${loc ? `, Location: ${loc}` : ''}`,
    outcome: 'info',
  })

  if (res.status === null) {
    return { kind: 'no-https-upgrade', title: 'Нет upgrade на HTTPS', verdict: 'not-exploitable', steps, evidence: null }
  }

  if (redirectsToHttps) {
    steps.push({ label: 'Итог', detail: 'http корре��тно редиректит на https.', outcome: 'refuted' })
    return { kind: 'no-https-upgrade', title: 'Нет upgrade на HTTPS', verdict: 'not-exploitable', steps, evidence: null }
  }

  const servesContent = res.status === 200 && res.body.length > 0
  steps.push({
    label: 'Итог',
    detail: servesContent
      ? 'http отдаёт контент по коду 200 без редиректа на https — трафик может идти в открытом виде.'
      : 'http не редиректит на https.',
    outcome: 'confirmed',
  })
  return {
    kind: 'no-https-upgrade',
    title: 'Нет upgrade на HTTPS',
    verdict: servesContent ? 'exploitable' : 'likely',
    steps,
    evidence: null,
  }
}

/** Пробив TLS: перечитываем сертификат и формулируем конкретную проблему. */
async function drillTls(origin: string): Promise<DrillResult> {
  const steps: DrillStep[] = []
  let host: string
  try {
    host = new URL(origin).hostname
  } catch {
    return { kind: 'tls', title: 'Проблема TLS', verdict: 'inconclusive', steps, evidence: null }
  }
  const tls = await checkTls(new URL(origin))
  steps.push({
    label: `TLS-хендшейк с ${host}`,
    detail: tls.tested ? `протокол ${tls.protocol ?? 'н/д'}, издатель ${tls.issuer ?? 'н/д'}` : tls.note,
    outcome: 'info',
  })
  const problems: string[] = []
  if (tls.tested) {
    if (!tls.authorized) problems.push('цепочка не доверенная')
    if (!tls.hostnameMatch) problems.push('имя хоста не совпадает с сертификатом')
    if (tls.daysLeft !== null && tls.daysLeft < 0) problems.push('сертификат просрочен')
    else if (tls.daysLeft !== null && tls.daysLeft < 14) problems.push(`истекает через ${tls.daysLeft} дн.`)
    if (tls.protocol && /^TLSv1(\.[01])?$/.test(tls.protocol)) problems.push(`устаревший протокол ${tls.protocol}`)
  }
  steps.push({
    label: 'Проверка сертификата',
    detail: problems.length ? `Проблемы: ${problems.join('; ')}.` : 'Явных проблем с сертификатом не обнаружено.',
    outcome: problems.length ? 'confirmed' : 'refuted',
  })
  return {
    kind: 'tls',
    title: 'Проблема TLS-сертификата',
    verdict: problems.length ? 'likely' : 'not-exploitable',
    steps,
    evidence: problems.length ? problems.join('\n') : null,
  }
}

/**
 * Экшен «пробить находку»: подтверждающие read-only проверки + AI-заключение
 * именно по этой находке. Гейт requireGod, SSRF-guard.
 */
export async function secretDrillFindingAction(
  rawUrl: string,
  kind: DrillKind,
  arg: string | null,
  withAi = true,
): Promise<DrillActionResult> {
  await requireGod()
  const url = normalizeUrl(rawUrl)
  if (!url) {
    return { ok: false, message: 'Некорректный адрес.' }
  }
  const blocked = await guardPublicHost(url.hostname)
  if (blocked) return { ok: false, message: blocked }

  // Финальный origin после редиректов, чтобы бить по реальному хосту.
  let origin = `${url.protocol}//${url.host}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const { finalUrl: fin } = await guardedFetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'user-agent': BROWSER_UA },
    })
    origin = `${fin.protocol}//${fin.host}`
  } catch {
    /* если не ответил — drill сам это отразит */
  } finally {
    clearTimeout(timer)
  }

  const result = await drillFinding(kind, origin, arg)

  // AI-заключение по конкретной находке — опционально и под общим rate-limit
  // (в авто-скане выключено: итоговое заключение покрывает все находки).
  let report: string | undefined
  if (withAi && reserveAiSlot()) {
    try {
      const { assessFinding } = await import('@/lib/god-pentest')
      const r = await assessFinding({ host: url.hostname, origin, drill: result })
      if (r.ok) report = r.report
    } catch {
      /* заключение опционально */
    }
  }

  return { ok: true, message: 'Готово', data: result, report }
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
      headers: { 'user-agent': BROWSER_UA },
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
