'use server'

import { notFound } from 'next/navigation'
import { lookup, resolveTxt, resolveCaa } from 'node:dns/promises'
import { isIP } from 'node:net'
import { connect as tlsConnect, checkServerIdentity } from 'node:tls'
import type { PeerCertificate } from 'node:tls'
import { requireAdmin } from '@/lib/auth'
import { isGodUnlocked } from '@/lib/god-gate'
import { computeScore, type SecurityScore } from '@/lib/god-audit-score'
import type { ReconSummary } from '@/lib/god-pentest'

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

const DEFAULT_ATTEMPTS = 4
const TIMEOUT_MS = 10_000

/**
 * Глобальный «бюджет» одного полного скана. Весь конвейер (ping + аудит +
 * утечки путей + drill + recon + перебор поддоменов + S3) раньше запускал сотни
 * исходящих соединений через несвязанные Promise.all и мог висеть очень долго.
 * Ограничиваем: (1) общий дедлайн, после которого новые пробы не стартуют,
 * (2) пул параллелизма для тяжёлых fan-out'ов.
 */
const SCAN_BUDGET_MS = 90_000
const MAX_CONCURRENCY = 12

/**
 * Дедлайн передаётся ЯВНО (не через модульную переменную): server actions могут
 * выполняться конкурентно, и общий mutable-стейт «протёк» бы между сканами.
 * true, если общий бюджет скана исчерпан — новые фазы/пробы стартовать не нужно.
 */
function scanExpired(deadline: number): boolean {
  return Date.now() > deadline
}

/**
 * Выполнить асинхронную операцию над каждым элементом с ограничением на число
 * одновременно выполняемых операций. Порядок результатов сохраняется, как у
 * Promise.all. Заменяет «запусти всё разом», не меняя семантику для вызывающих.
 */
async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = new Array(Math.min(Math.max(1, limit), items.length || 1))
    .fill(0)
    .map(async () => {
      for (;;) {
        const i = cursor++
        if (i >= items.length) return
        results[i] = await fn(items[i], i)
      }
    })
  await Promise.all(workers)
  return results
}

/**
 * Реалистичный браузерный User-Agent. Кастомные UA часто режутся WAF/CDN
 * (403/таймаут), из-за чего живой сайт выглядел бы недоступным — поэтому
 * все пассивные проверки представляются обычным браузером.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/**
 * Полный набор заголовков реального браузера (навигационный запрос Chrome).
 * Многие WAF/CDN (в т.ч. Cloudflare) отдают challenge/403 на «голые» запросы
 * без Accept, Accept-Language и Sec-Fetch-*; повторяя браузерный набор, мы
 * проходим базовую эвристику бота. При наличии cookie от пользователя
 * (например, cf_clearance, скопированные из браузера) — прикладываем их.
 */
function browserHeaders(cookie?: string | null): Record<string, string> {
  const h: Record<string, string> = {
    'user-agent': BROWSER_UA,
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9,ru;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
    'upgrade-insecure-requests': '1',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
  }
  if (cookie && cookie.trim()) h['cookie'] = cookie.trim().slice(0, 4096)
  return h
}

/**
 * Детектор страницы-вызова Cloudflare (и похожих WAF-интерстишлов). Смотрит на
 * статус + характерные маркеры тела/заголовков. Это НЕ обход — мы лишь честно
 * распознаём, что вместо контента нам отдали проверочную страницу.
 */
function detectCloudflareChallenge(
  status: number,
  body: string,
  headers: Headers,
): { isChallenge: boolean; note: string | null } {
  const b = body.toLowerCase()
  const markers = [
    'cf-browser-verification',
    'cf_chl_opt',
    '__cf_chl_',
    'cf-challenge',
    'challenge-platform',
    'just a moment',
    'checking your browser',
    'enable javascript and cookies to continue',
    'attention required',
  ]
  const hit = markers.some((m) => b.includes(m))
  const cfMitigated = headers.get('cf-mitigated') === 'challenge'
  const blockedStatus = status === 403 || status === 503 || status === 429
  if (cfMitigated || (hit && blockedStatus) || (hit && b.includes('challenge-platform'))) {
    return {
      isChallenge: true,
      note:
        'Cloudflare WAF: активен, отдана страница-вызов (challenge). Обход не удался. ' +
        'Рекомендация: найдите реальный IP через SecurityTrails/Censys, ' +
        'либо скопируйте cookie из браузера (в т.ч. cf_clearance) и передайте их в поле cookie.',
    }
  }
  return { isChallenge: false, note: null }
}

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

// Примечание: единственная точка входа вкладки — secretFullScanAction (ниже),
// который сам делает ping через pingOnce(). Отдельный публичный
// secretPingAction удалён как неиспользуемый server-action endpoint
// (сокращение attack surface — лишних '"use server"' точек входа быть не должно).

/** Один замер: время от запроса до заголовков ответа. */
async function pingOnce(
  url: URL,
  seq: number,
  cold: boolean,
  cookie?: string | null,
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
      headers: browserHeaders(cookie),
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
  /** Осталось дней до истечения (может быть отрицательным). */
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
  /** Вместо контента отдана страница-вызов WAF (Cloudflare challenge и т.п.). */
  challenge: boolean
  /** Пояснение/рекомендация по challenge (если обнаружен). */
  challengeNote: string | null
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
      challenge: false,
      challengeNote: null,
      note: 'Проверка не выполнена — хост не ответил.',
    } as InfraCheck,
  }
}

/** Собрать пассивный аудит по URL. Вызывается только из гейт-экшена. */
async function collectAudit(url: URL, cookie?: string | null): Promise<SecurityAudit> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const started = performance.now()
  try {
    // SSRF-safe: следим за редиректами вручную, проверяя каждый переход.
    // Полный браузерный набор заголовков (+ cookie пользователя) — чтобы
    // пройти базовую бот-эвристику Cloudflare/WAF, а не получить сразу 403.
    const { res, finalUrl } = await guardedFetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: browserHeaders(cookie),
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

    // Читаем тело (с ограничением) для mixed content И для детекции challenge.
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
    const isHtmlResp =
      contentType.includes('text/html') || contentType.includes('xhtml')
    let bodyForScan = ''
    if (isHtmlResp) {
      bodyForScan = await readCapped(res, 262_144)
    } else {
      void res.body?.cancel()
    }

    // Распознаём страницу-вызов Cloudflare/WAF (честная детекция, не обход).
    const challenge = detectCloudflareChallenge(res.status, bodyForScan, res.headers)
    const infra = detectInfra(res.headers, cookies, challenge)

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
function detectInfra(
  headers: Headers,
  cookies: CookieFlags[],
  challenge: { isChallenge: boolean; note: string | null } = { isChallenge: false, note: null },
): InfraCheck {
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

  // Страница-вызов означает, что WAF точно активен, даже если заголовков мало.
  if (challenge.isChallenge && !waf) waf = cdn === 'Cloudflare' ? 'Cloudflare' : (cdn ?? 'WAF')

  const parts: string[] = []
  if (cdn) parts.push(`CDN: ${cdn}`)
  if (waf) parts.push(`WAF: ${waf}`)
  if (!cdn && !waf) parts.push('CDN/WAF по заголовкам не определён')
  if (privateCacheable)
    parts.push('ответ с cookie помечен публично кэшируемым — риск утечки')
  if (challenge.isChallenge) parts.push('отдана страница-вызов (challenge) — контент недоступен')

  return {
    cdn,
    waf,
    server,
    cacheControl,
    privateCacheable,
    challenge: challenge.isChallenge,
    challengeNote: challenge.note,
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
  // Несколько источников mixed content на https-странице:
  //  • атрибуты src/href/action (скрипты, стили, картинки, формы),
  //  • srcset (responsive-картинки, может содержать несколько URL),
  //  • CSS url(...) в inline-стилях и <style> (фоны, шрифты),
  //  • @import в CSS (подгрузка стороннего CSS).
  const patterns: RegExp[] = [
    /(?:src|href|action)\s*=\s*["'](http:\/\/[^"']+)["']/gi,
    /(?:srcset|imagesrcset)\s*=\s*["']([^"']*http:\/\/[^"']+)["']/gi,
    /url\(\s*["']?(http:\/\/[^)"']+)/gi,
    /@import\s+["'](http:\/\/[^"']+)["']/gi,
  ]
  const samples: string[] = []
  const seen = new Set<string>()
  let count = 0
  const isNamespace = (u: string) =>
    /^http:\/\/(www\.)?w3\.org|^http:\/\/schema\.org|^http:\/\/(www\.)?openxmlformats\.org|^http:\/\/purl\.org/i.test(
      u,
    )
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) && count < 200) {
      // srcset может содержать несколько http://-ссылок в одном значении —
      // достаём каждую отдельно.
      const matches = m[1].match(/http:\/\/[^\s,'")]+/gi) ?? [m[1]]
      for (const u of matches) {
        // http://schema.org и подобные пространства имён — не загрузка ресурса.
        if (isNamespace(u)) continue
        count++
        if (samples.length < 5 && !seen.has(u)) {
          seen.add(u)
          samples.push(u)
        }
      }
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

  // Одна проба заданным методом: возвращает вердикт либо null (неинформативно).
  async function probe(method: 'HEAD' | 'GET'): Promise<'yes' | 'no' | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(httpUrl, {
        method,
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
      // Успешный ответ по http без редиректа — апгрейда нет.
      if (res.status < 400) return 'no'
      // 405/501 (метод не поддержан) и прочие 4xx/5xx — неинформативно,
      // пусть решает следующая проба (GET).
      return null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  // Сначала лёгкий HEAD; если сервер его не поддерживает (405/501) или ответ
  // неинформативен — повторяем полноценным GET, т.к. на GET сайт может
  // редиректить на HTTPS, а на HEAD — нет (частый ложноотрицательный вывод).
  const head = await probe('HEAD')
  if (head !== null) return head
  const get = await probe('GET')
  return get ?? 'unknown'
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
          ? 'Ответ не HTML, но ввод отражается в заголовке ответа — потенциальный риск'
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
  const results = await mapPool(
    SENSITIVE_PATHS,
    MAX_CONCURRENCY,
    async ({ path, severity, confirm }) => {
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
    },
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
// secretPathLeaksAction удалён: утечки путей проверяет secretFullScanAction
// через checkPathLeaks() в общем проходе. Отдельный публичный endpoint не нужен.

/* ------------------------- DNS / почтовая гигиена ----------------------- */

/** Распространённые DKIM-селекторы для best-effort проверки. */
const DKIM_SELECTORS = ['default', 'google', 'selector1', 'selector2', 'k1', 'mail', 's1']

/**
 * Составные публичные суффиксы (мини-PSL). Нужны, чтобы для `sub.example.co.uk`
 * получить регистрируемый домен `example.co.uk`, а не `co.uk`.
 */
const MULTI_PART_TLDS = new Set([
  // Великобритания
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk',
  // Австралия / Новая Зеландия
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  // Азия
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'ad.jp',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'co.kr', 'or.kr', 're.kr', 'com.hk', 'org.hk', 'com.tw', 'org.tw', 'idv.tw',
  'com.sg', 'com.my', 'org.my', 'net.my', 'gov.my',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in',
  'co.id', 'or.id', 'web.id', 'ac.id', 'go.id',
  'com.ph', 'com.vn', 'com.pk', 'com.bd', 'co.th', 'in.th', 'or.th', 'ac.th', 'go.th',
  'com.sa', 'com.eg', 'co.il', 'org.il', 'ac.il', 'gov.il',
  // Европа
  'com.tr', 'com.ua', 'com.pl', 'com.ru', 'com.es', 'com.de', 'co.at', 'or.at',
  'com.gr', 'com.pt', 'com.ro', 'com.hr', 'com.cy',
  // Латинская Америка
  'com.br', 'net.br', 'org.br', 'gov.br', 'com.mx', 'com.ar', 'com.co', 'com.pe',
  'com.ec', 'com.uy', 'co.ve', 'com.ve', 'com.bo', 'com.py', 'com.cl',
  // Африка
  'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za',
  'co.ke', 'or.ke', 'com.ng', 'org.ng', 'com.gh', 'com.eg',
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

// secretSecurityAuditAction удалён: аудит собирает secretFullScanAction через
// collectAudit() в общем проходе. Отдельный публичный endpoint не нужен.

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

// secretSecurityAssessAction удалён: AI-заключение формирует secretFullScanAction
// в конце общего прохода (assessSecurity под тем же reserveAiSlot rate-limit).

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
    steps.push({ label: 'Итог', detail: 'http корректно редиректит на https.', outcome: 'refuted' })
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

// secretDrillFindingAction удалён: «пробив» находок выполняет
// secretFullScanAction через drillFinding() по каждой находке из findingsToDrill().

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

// S3ScanResult / S3ScanActionResult удалены вместе с secretS3ScanAction.
// Авто-скан агрегирует находки в тип из scanDomainBuckets() (ниже).

/** Валидное имя S3-бакета: 3–63 символа, [a-z0-9.-], край — буква/цифра. */
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

// parseBucket удалён вместе с secretS3ScanAction (ручной ввод имени бакета).
// Авто-скан работает по одноимённым кандидатам из scanDomainBuckets().

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
    // Финальный flush: дописываем «хвост» многобайтового символа, повисший
    // на границе последнего чанка (иначе он молча терялся).
    text += decoder.decode()
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

/** Классифицировать ответ S3-эндпоинта. */
function classifyOutcome(r: S3Response): S3Probe['outcome'] {
  if (r.status === null) return 'error'
  if (r.status === 200 && r.body.includes('<ListBucketResult')) return 'public-listing'
  if (r.status === 403) return 'access-denied'
  if (r.status === 404) return 'not-found'
  if (r.status === 301 || r.status === 307) return 'redirect'
  return 'other'
}

// toProbe / extractCode / extractKeys / countKeys удалены: они обслуживали
// подробный ручной S3-отчёт (secretS3ScanAction). Авто-скан использует только
// classifyOutcome() для вердикта по одноимённым бакетам.

// secretS3ScanAction удалён: одноимённые бакеты проверяет secretFullScanAction
// через scanDomainBuckets() в общем проходе. Отдельный публичный endpoint не нужен.

/* ===================================================================== */
/*  Разведка периметра (recon) — CMS, API, GraphQL, поддомены, редиректы  */
/*                                                                        */
/*  Дополнительные ПАССИВНЫЕ проверки для карты атакуемой поверхности     */
/*  своего домена. Инструмент только НАБЛЮДАЕТ ответы (коды, заголовки,   */
/*  read-only GraphQL introspection, DNS-резолв поддоменов) — он ничего   */
/*  не эксплуатирует, не пишет и не меняет данные. В частности эндпоинт   */
/*  смены пароля НЕ вызывается на запись: фиксируется только его наличие  */
/*  и разрешённые методы для ручной проверки. Всё под guardPublicHost.    */
/* ===================================================================== */

/** Короткий таймаут для recon-проб — их много, каждая должна быть быстрой. */
const RECON_TIMEOUT_MS = 7000

/** Определение CMS/фреймворка по заголовкам, телу и характерным путям. */
export interface CmsDetection {
  tested: boolean
  name: string | null
  version: string | null
  /** Найденные пути к админке/панели (вернувшие < 400). */
  adminPaths: string[]
  /** Признаки, по которым сделан вывод. */
  evidence: string[]
  note: string
}

/** Проба одного API-эндпоинта. */
export interface EndpointProbe {
  path: string
  status: number | null
  contentType: string | null
  /** Эндпоинт «жив» (ответил не 404 и не сетевой ошибкой). */
  present: boolean
  note: string
}

/** Проба чувствительного auth-эндпоинта (только наблюдение, без эксплуатации). */
export interface AuthProbe {
  path: string
  status: number | null
  /** Разрешённые методы (из Allow / ACAM), если сервер их сообщил. */
  methods: string[]
  risk: 'none' | 'low' | 'medium' | 'high'
  note: string
}

/** Результат проверки GraphQL introspection (read-only запрос схемы). */
export interface GraphqlCheck {
  tested: boolean
  endpoint: string | null
  introspectionEnabled: boolean
  queryCount: number | null
  mutationCount: number | null
  /** Несколько имён типов из схемы (для наглядности). */
  sampleTypes: string[]
  note: string
}

/** Активный поддомен, найденный перебором распространённых имён. */
export interface SubdomainResult {
  host: string
  ip: string | null
  status: number | null
  note: string
}

/** Проверка на открытый редирект (внешний Location по параметру). */
export interface OpenRedirectCheck {
  tested: boolean
  vulnerable: boolean
  param: string | null
  evidence: string | null
  note: string
}

/**
 * Проба Cockpit CMS / headless-API эндпоинта. ТОЛЬКО статус: определяем, что
 * эндпоинт существует и требует ли он авторизации. Записи НЕ читаются и НЕ
 * сохраняются — это детекция открытой поверхности, а не выгрузка данных.
 */
export interface CockpitProbe {
  path: string
  status: number | null
  exists: boolean
  requiresAuth: boolean
  /** Открыт без авторизации — потенциально утечка данных. */
  openWithoutAuth: boolean
  note: string
}

/** Свод результатов разведки периметра. */
export interface ReconResult {
  cms: CmsDetection
  endpoints: EndpointProbe[]
  authProbes: AuthProbe[]
  graphql: GraphqlCheck
  subdomains: SubdomainResult[]
  openRedirect: OpenRedirectCheck
  /** Cockpit / headless-CMS эндпоинты — только статусы доступности. */
  cockpit: CockpitProbe[]
}

/** Лёгкий GET/OPTIONS с guard'ом хоста и коротким таймаутом; читает тело. */
async function reconFetch(
  target: string,
  opts: { method?: string; readBody?: boolean; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number | null; contentType: string | null; body: string; location: string | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RECON_TIMEOUT_MS)
  try {
    let u: URL
    try {
      u = new URL(target)
    } catch {
      return { status: null, contentType: null, body: '', location: null }
    }
    const blocked = await guardPublicHost(u.hostname)
    if (blocked) return { status: null, contentType: null, body: '', location: null }
    const res = await fetch(u, {
      method: opts.method ?? 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'user-agent': BROWSER_UA, ...(opts.headers ?? {}) },
      body: opts.body,
    })
    const contentType = res.headers.get('content-type')
    const location = res.headers.get('location')
    const body = opts.readBody ? await readCapped(res, 131_072) : (void res.body?.cancel(), '')
    return { status: res.status, contentType, body, location }
  } catch {
    return { status: null, contentType: null, body: '', location: null }
  } finally {
    clearTimeout(timer)
  }
}

/** Достать версию из meta generator / заголовков. */
function extractVersion(body: string, name: RegExp): string | null {
  const m = body.match(name)
  return m && m[1] ? m[1] : null
}

/**
 * Определить CMS/фреймворк: тянет главную страницу (тело + заголовки) и
 * сверяет характерные маркеры; затем проверяет наличие типовых путей к панели.
 */
async function detectCms(origin: string): Promise<CmsDetection> {
  const home = await reconFetch(origin, { readBody: true })
  const body = home.body
  const evidence: string[] = []
  let name: string | null = null
  let version: string | null = null

  // meta generator — самый надёжный источник.
  const gen = body.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i)
  if (gen) evidence.push(`meta generator: ${gen[1]}`)

  // Детекция по РЕАЛЬНЫМ маркерам в теле/generator, а НЕ по факту «путь не 404».
  // Кастомный роут /admin или /cockpit/ на Next.js больше не даёт ложный вывод.

  // WordPress — характерные пути ассетов и generator.
  if (/wp-content\/|wp-includes\/|\/wp-json\b/i.test(body) || /wordpress/i.test(gen?.[1] ?? '')) {
    name = 'WordPress'
    version = extractVersion(body, /WordPress\s+([\d.]+)/i) ?? extractVersion(gen?.[1] ?? '', /WordPress\s+([\d.]+)/i)
    evidence.push('маркеры wp-content / wp-json в HTML')
  }
  // Cockpit CMS — только по настоящим маркерам движка, не по слову "cockpit".
  else if (
    /cockpit/i.test(gen?.[1] ?? '') ||
    /\/modules\/App\/assets\//i.test(body) ||
    /data-version=|window\.COCKPIT|"cockpit"\s*:/i.test(body)
  ) {
    name = 'Cockpit CMS'
    version = extractVersion(body, /data-version=["']([\d.]+)["']/i)
    evidence.push('маркеры движка Cockpit в HTML (assets/data-version)')
  }
  // Drupal / Joomla — по generator.
  else if (/drupal/i.test(gen?.[1] ?? '')) {
    name = 'Drupal'
    version = extractVersion(gen?.[1] ?? '', /Drupal\s+([\d.]+)/i)
    evidence.push('generator: Drupal')
  } else if (/joomla/i.test(gen?.[1] ?? '')) {
    name = 'Joomla'
    evidence.push('generator: Joomla')
  }
  // Next.js — по __NEXT_DATA__ и путям _next/static. Помогает отсечь ложные CMS.
  else if (/__NEXT_DATA__|\/_next\/static\/|next\/dist\//i.test(body)) {
    name = 'Next.js'
    evidence.push('маркеры Next.js (__NEXT_DATA__ / _next/static)')
  }
  // NestJS / Express — по характерному ответу.
  else if (/cannot get \//i.test(body) && body.length < 200) {
    name = 'Express/NestJS'
    evidence.push('характерный ответ "Cannot GET /"')
  }

  const isNextJs = name === 'Next.js' || /__NEXT_DATA__|\/_next\/static\//i.test(body)

  // Пути к панели засчитываем ТОЛЬКО если тело реально содержит маркер CMS,
  // а не просто вернуло < 400 (кастомные роуты Next.js возвращают 200).
  const CMS_PATHS: { path: string; markers: RegExp }[] = [
    { path: '/wp-login.php', markers: /wp-submit|user_login|wordpress/i },
    { path: '/wp-admin/', markers: /wp-admin|wordpress|wp-login/i },
    { path: '/administrator/', markers: /joomla|com_login|mod-login/i },
    { path: '/cockpit/', markers: /\/modules\/App\/assets\/|window\.COCKPIT|cockpit/i },
    { path: '/user/login', markers: /drupal|user-login-form/i },
  ]
  const pathResults = await Promise.all(
    CMS_PATHS.map(async ({ path, markers }) => {
      const r = await reconFetch(`${origin}${path}`, { readBody: true })
      // 200 без маркеров на Next.js — это кастомный роут, а не панель CMS.
      const confirmed = r.status !== null && r.status < 400 && markers.test(r.body)
      return { path, confirmed }
    }),
  )
  const adminPaths = pathResults.filter((r) => r.confirmed).map((r) => r.path)
  if (!name && adminPaths.some((p) => p.startsWith('/wp-'))) name = 'WordPress'
  if (!name && adminPaths.includes('/cockpit/')) name = 'Cockpit CMS'

  const note = name
    ? `Обнаружено: ${name}${version ? ` ${version}` : ''}${
        isNextJs && name !== 'Next.js' ? ' (на базе Next.js)' : ''
      }.`
    : 'CMS/фреймворк по надёжным маркерам не определён.'
  return { tested: home.status !== null, name, version, adminPaths, evidence, note }
}

/** Проверить наличие типовых API-эндпоинтов. */
async function probeApiEndpoints(origin: string): Promise<EndpointProbe[]> {
  const PATHS = ['/api', '/api/v1', '/graphql', '/rest', '/auth', '/.well-known/openid-configuration', '/swagger.json', '/openapi.json']
  return Promise.all(
    PATHS.map(async (path): Promise<EndpointProbe> => {
      const r = await reconFetch(`${origin}${path}`)
      const present = r.status !== null && r.status !== 404
      const note =
        r.status === null
          ? 'нет ответа'
          : r.status === 404
            ? 'не найден'
            : r.status === 401 || r.status === 403
              ? 'существует, требует авторизации'
              : r.status < 400
                ? 'доступен без авторизации'
                : `ответ ${r.status}`
      return { path, status: r.status, contentType: r.contentType, present, note }
    }),
  )
}

/**
 * Пробы чувствительных auth-эндпоинтов. ВАЖНО: никаких записей — только GET и
 * OPTIONS. Для /auth/guest фиксируем, не выдаётся ли токен анониму; для смены
 * пароля — только наличие и методы (реальную смену НЕ выполняем).
 */
async function probeAuthEndpoints(origin: string): Promise<AuthProbe[]> {
  const out: AuthProbe[] = []

  // /auth/guest — гостевая авторизация. Читаем тело, ищем JWT-подобный токен.
  {
    const r = await reconFetch(`${origin}/auth/guest`, { readBody: true })
    let risk: AuthProbe['risk'] = 'none'
    let note = 'эндпоинт не отвечает или отсутствует'
    if (r.status !== null && r.status !== 404) {
      const looksJwt = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/.test(r.body)
      const hasToken = /"(access_?token|jwt|token)"\s*:/i.test(r.body)
      if (r.status < 400 && (looksJwt || hasToken)) {
        risk = 'high'
        note = 'гостевая авторизация выдаёт токен анонимному клиенту — потенциальный риск'
      } else if (r.status < 400) {
        risk = 'low'
        note = 'эндпоинт доступен без авторизации (токен не обнаружен в ответе)'
      } else {
        note = `эндпоинт существует, ответ ${r.status}`
      }
    }
    out.push({ path: '/auth/guest', status: r.status, methods: [], risk, note })
  }

  // /auth/password/v2/change — только OPTIONS + GET: фиксируем наличие и методы.
  {
    const opt = await reconFetch(`${origin}/auth/password/v2/change`, { method: 'OPTIONS' })
    const get = await reconFetch(`${origin}/auth/password/v2/change`)
    const status = opt.status ?? get.status
    const methods: string[] = []
    let risk: AuthProbe['risk'] = 'none'
    let note = 'эндпоинт не отвечает или отсутствует'
    const present = status !== null && status !== 404
    if (present) {
      risk = 'medium'
      note =
        'эндпоинт смены пароля существует — проверьте ВРУЧНУЮ, требует ли он старый пароль (автоматически не эксплуатируем)'
    }
    out.push({ path: '/auth/password/v2/change', status, methods, risk, note })
  }

  return out
}

/**
 * GraphQL introspection: read-only запрос схемы. Если introspection включён —
 * возвращает список query/mutation. Никакие мутации НЕ выполняются.
 */
async function checkGraphql(origin: string): Promise<GraphqlCheck> {
  const ENDPOINTS = ['/graphql', '/api/graphql', '/v1/graphql', '/query']
  const introspectionQuery = JSON.stringify({
    query:
      'query{__schema{queryType{name} mutationType{name} types{name kind}}}',
  })
  for (const ep of ENDPOINTS) {
    const r = await reconFetch(`${origin}${ep}`, {
      method: 'POST',
      readBody: true,
      headers: { 'content-type': 'application/json' },
      body: introspectionQuery,
    })
    if (r.status === null || r.status === 404) continue
    // Ответ должен быть JSON со схемой.
    if (!/application\/json/i.test(r.contentType ?? '') && !r.body.includes('__schema')) continue
    try {
      const json = JSON.parse(r.body) as {
        data?: { __schema?: { queryType?: { name?: string }; mutationType?: { name?: string } | null; types?: { name: string; kind: string }[] } }
      }
      const schema = json.data?.__schema
      if (!schema) {
        return {
          tested: true,
          endpoint: ep,
          introspectionEnabled: false,
          queryCount: null,
          mutationCount: null,
          sampleTypes: [],
          note: `GraphQL найден на ${ep}, но introspection отключён (хорошо).`,
        }
      }
      const types = (schema.types ?? []).filter((t) => t.name && !t.name.startsWith('__'))
      const objectTypes = types.filter((t) => t.kind === 'OBJECT').map((t) => t.name)
      return {
        tested: true,
        endpoint: ep,
        introspectionEnabled: true,
        queryCount: schema.queryType ? 1 : 0,
        mutationCount: schema.mutationType ? 1 : 0,
        sampleTypes: objectTypes.slice(0, 12),
        note: `GraphQL introspection ВКЛЮЧЁН на ${ep} — схема данных доступна публично (рекомендуется отключить в проде).`,
      }
    } catch {
      continue
    }
  }
  return {
    tested: true,
    endpoint: null,
    introspectionEnabled: false,
    queryCount: null,
    mutationCount: null,
    sampleTypes: [],
    note: 'GraphQL-эндпоинт не обнаружен.',
  }
}

/** Распространённые поддомены для быстрой разведки. */
const COMMON_SUBDOMAINS = [
  'www', 'api', 'admin', 'app', 'dev', 'staging', 'test', 'beta',
  'cockpit', 'payment-api', 'payments', 'storage', 'cdn', 'static',
  'mail', 'webmail', 'vpn', 'portal', 'git', 'gitlab', 'jenkins',
  'grafana', 'kibana', 'dashboard', 'auth', 'sso', 'm', 'mobile',
]

/**
 * Разведка поддоменов: резолвим распространённые имена (DNS), для найденных —
 * снимаем HTTP-статус. Приватные адреса отбрасываются (SSRF-guard).
 */
async function enumerateSubdomains(host: string): Promise<SubdomainResult[]> {
  const org = registrableDomain(host)
  const results = await mapPool(
    COMMON_SUBDOMAINS,
    MAX_CONCURRENCY,
    async (sub): Promise<SubdomainResult | null> => {
      const fqdn = `${sub}.${org}`
      let ip: string | null = null
      try {
        const rec = await lookup(fqdn)
        ip = rec.address
      } catch {
        return null // не резолвится — поддомена нет
      }
      if (isPrivateIp(ip)) {
        return { host: fqdn, ip: null, status: null, note: 'резолвится в приватный адрес — пропущено' }
      }
      const r = await reconFetch(`https://${fqdn}/`)
      const status = r.status
      const note =
        status === null
          ? 'DNS есть, HTTP не ответил'
          : status < 400
            ? 'активен'
            : status < 500
              ? `отвечает (${status})`
              : `ошибка сервера (${status})`
      return { host: fqdn, ip, status, note }
    },
  )
  return results.filter((r): r is SubdomainResult => r !== null)
}

/**
 * Проверка открытого редиректа: подставляем внешний адрес в типовые параметры
 * и смотрим, не уводит ли Location на чужой домен. Редирект НЕ следуется.
 */
async function checkOpenRedirect(origin: string): Promise<OpenRedirectCheck> {
  const PARAMS = ['next', 'url', 'redirect', 'return', 'returnUrl', 'dest', 'continue', 'r']
  const evil = 'https://od-redirect-probe.example/'
  for (const param of PARAMS) {
    const target = `${origin}/?${param}=${encodeURIComponent(evil)}`
    const r = await reconFetch(target)
    if (r.status !== null && r.status >= 300 && r.status < 400 && r.location) {
      try {
        const loc = new URL(r.location, origin)
        if (loc.hostname === 'od-redirect-probe.example') {
          return {
            tested: true,
            vulnerable: true,
            param,
            evidence: `?${param}= → Location: ${r.location}`,
            note: `Параметр "${param}" позволяет редирект на внешний домен — открытый редирект (риск фишинга/обхода).`,
          }
        }
      } catch {
        /* невалидный Location — не считаем уязвимостью */
      }
    }
  }
  return {
    tested: true,
    vulnerable: false,
    param: null,
    evidence: null,
    note: 'Открытых редиректов по типовым параметрам не обнаружено.',
  }
}

/** Выполнить всю разведку периметра параллельно (насколько возможно). */
/**
 * Проверить типовые Cockpit / headless-CMS эндпоинты. ТОЛЬКО статус (HEAD/GET
 * без чтения записей): существует ли эндпоинт и требует ли он авторизации.
 * Никакие коллекции/записи/PII не читаются и не сохраняются.
 */
async function probeCockpit(origin: string): Promise<CockpitProbe[]> {
  const PATHS = [
    '/api/collections',
    '/api/collections/get',
    '/api/content/items',
    '/api/gql',
    '/api/pages',
    '/api/singletons',
  ]
  const probes = await Promise.all(
    PATHS.map(async (path): Promise<CockpitProbe> => {
      // Только заголовки: тело (записи) намеренно не читаем.
      const r = await reconFetch(`${origin}${path}`, { method: 'GET' })
      const status = r.status
      const exists = status !== null && status !== 404
      const requiresAuth = status === 401 || status === 403
      const openWithoutAuth = status !== null && status >= 200 && status < 300
      const note =
        status === null
          ? 'нет ответа'
          : status === 404
            ? 'не найден'
            : requiresAuth
              ? 'существует, требует авторизации (ок)'
              : openWithoutAuth
                ? 'доступен БЕЗ авторизации — проверьте, не утекают ли данные'
                : `ответ ${status}`
      return { path, status, exists, requiresAuth, openWithoutAuth, note }
    }),
  )
  // Возвращаем только реально существующие эндпоинты, чтобы не шуметь.
  return probes.filter((p) => p.exists)
}

async function collectRecon(origin: string, host: string): Promise<ReconResult> {
  const [cms, endpoints, authProbes, graphql, subdomains, openRedirect, cockpit] = await Promise.all([
    detectCms(origin),
    probeApiEndpoints(origin),
    probeAuthEndpoints(origin),
    checkGraphql(origin),
    enumerateSubdomains(host),
    checkOpenRedirect(origin),
    probeCockpit(origin),
  ])
  return { cms, endpoints, authProbes, graphql, subdomains, openRedirect, cockpit }
}

/* ===================================================================== */
/*  S3: детекция бакетов по типовым паттернам имени (БЕЗ выгрузки ключей)  */
/*                                                                        */
/*  Автоскан перебирает распространённые варианты имени бакета для домена  */
/*  и фиксирует ТОЛЬКО состояние: существует / открыт листинг / закрыт.    */
/*  Ключи объектов и содержимое НЕ читаются и НЕ сохраняются — в отличие   */
/*  от ручного S3-экшена это чистая детекция поверхности.                  */
/* ===================================================================== */

/** Находка по одному кандидату-бакету (только состояние, без ключей). */
export interface S3BucketFinding {
  bucket: string
  region: string | null
  verdict: 'public' | 'private' | 'not-found' | 'unknown'
  note: string
}

/**
 * Определить состояние бакета БЕЗ чтения ключей: один virtual-hosted GET,
 * при необходимости — региональный. Возвращает только вердикт и регион.
 */
async function probeBucketState(bucket: string): Promise<{ verdict: S3BucketFinding['verdict']; region: string | null }> {
  const outcomes: S3Probe['outcome'][] = []
  let region: string | null = null

  const r1 = await s3Get(`https://${bucket}.s3.amazonaws.com/`)
  if (r1.region) region = r1.region
  outcomes.push(classifyOutcome(r1))

  // Если глобальный редиректнул на регион — уточняем одним запросом.
  if (region && !outcomes.includes('public-listing')) {
    const r2 = await s3Get(`https://${bucket}.s3.${region}.amazonaws.com/`)
    if (r2.region) region = r2.region
    outcomes.push(classifyOutcome(r2))
  }

  let verdict: S3BucketFinding['verdict'] = 'unknown'
  if (outcomes.includes('public-listing')) verdict = 'public'
  else if (outcomes.includes('access-denied')) verdict = 'private'
  else if (outcomes.includes('not-found')) verdict = 'not-found'
  return { verdict, region }
}

/**
 * Перебрать типовые паттерны имени бакета для домена и вернуть только те, что
 * реально существуют (public/private). Несуществующие отбрасываются, ключи
 * объектов не читаются.
 */
async function scanDomainBuckets(host: string): Promise<S3BucketFinding[]> {
  const org = registrableDomain(host)
  const base = org.split('.')[0]
  if (!base) return []
  const candidates = Array.from(
    new Set([
      base,
      `${base}-prod`,
      `${base}-production`,
      `${base}-static`,
      `${base}-assets`,
      `${base}-media`,
      `${base}-uploads`,
      `${base}-backup`,
      `${base}-backups`,
      org.replace(/\./g, '-'),
    ]),
  ).filter((b) => BUCKET_NAME_RE.test(b))

  const findings = await mapPool(
    candidates,
    MAX_CONCURRENCY,
    async (bucket): Promise<S3BucketFinding | null> => {
      const { verdict, region } = await probeBucketState(bucket)
      if (verdict === 'not-found' || verdict === 'unknown') return null
      const note =
        verdict === 'public'
          ? 'бакет существует, листинг ОТКРЫТ наружу — критично'
          : 'бакет существует, листинг закрыт (приватный)'
      return { bucket, region, verdict, note }
    },
  )
  return findings.filter((f): f is S3BucketFinding => f !== null)
}

/* ===================================================================== */
/*  Единый авто-скан: «домен + кнопка» → полный отчёт                      */
/*                                                                        */
/*  Одним серверным проходом выполняет ВСЕ проверки, автоматически        */
/*  «пробивает» подтверждённые находки, оппортунистически проверяет       */
/*  одноимённый S3-бакет и формирует AI-заключение по харденингу. Гейт    */
/*  requireGod, без audit() (инвариант AGENTS.md §4). Аудит целиком       */
/*  собирается сервером и не доверяется клиенту.                          */
/* ===================================================================== */

/** Одна авто-«пробитая» находка в составе полного скана. */
export interface AutoDrill {
  kind: DrillKind
  arg: string | null
  result: DrillResult
}

/** Полный результат авто-скана — всё, что нужно для единого отчёта. */
export interface FullScanResult {
  /** Доступность и задержка. */
  ping: PingResult | null
  /** Пассивный аудит + все дополнительные проверки + утечки путей. */
  audit: SecurityAudit
  /** Автоматически «пробитые» подтверждённые находки. */
  drills: AutoDrill[]
  /** Разведка периметра: CMS, API, GraphQL, поддомены, открытые редиректы. */
  recon: ReconResult | null
  /** Найденные S3-бакеты по типовым паттернам имени (только состояние, без ключей). */
  s3: S3BucketFinding[]
  /** AI-заключение по харденингу (markdown) или null, если недоступно. */
  report: string | null
  /** Причина, по которой заключение не сгенерировано (если report === null). */
  reportError: string | null
}

export interface FullScanActionResult {
  ok: boolean
  message: string
  data?: FullScanResult
}

/** Собрать список находок из аудита, которые имеет смысл авто-«пробить». */
function findingsToDrill(
  audit: SecurityAudit,
): { kind: DrillKind; arg: string | null }[] {
  const out: { kind: DrillKind; arg: string | null }[] = []
  // Открытые чувствительные пути — самое важное, пробиваем каждый.
  for (const leak of audit.pathLeaks) {
    if (leak.exposed && leak.severity !== 'info') {
      out.push({ kind: 'path-leak', arg: leak.path })
    }
  }
  if (audit.reflection.tested && audit.reflection.risk !== 'none') {
    out.push({ kind: 'reflection', arg: null })
  }
  if (audit.scheme === 'https' && !audit.hsts.present) {
    out.push({ kind: 'missing-hsts', arg: null })
  }
  if (audit.httpsUpgrade === 'no') {
    out.push({ kind: 'no-https-upgrade', arg: null })
  }
  if (audit.disclosure.length > 0) {
    out.push({ kind: 'software-disclosure', arg: null })
  }
  if (audit.tls.tested && (audit.tls.status === 'bad' || audit.tls.status === 'warn')) {
    out.push({ kind: 'tls', arg: null })
  }
  // Ограничиваем число проверок, чтобы не устроить лавину запросов.
  return out.slice(0, 8)
}

/**
 * Полный автоматический скан по одному домену. Выполняет доступность, полный
 * пассивный аудит (со всеми проверками), утечки путей, авто-«пробив»
 * подтверждённых находок, оппортунистический скан S3-бакета и AI-заключение.
 */
export async function secretFullScanAction(
  rawUrl: string,
  authorized: boolean,
  cookie?: string | null,
): Promise<FullScanActionResult> {
  await requireGod()

  // Подтверждение права тестировать домен — обязательный шлюз перед активными
  // recon-пробами (перебор поддоменов/бакетов/эндпоинтов).
  if (!authorized) {
    return {
      ok: false,
      message:
        'Подтвердите, что вы владеете доменом или имеете разрешение на его тестирование.',
    }
  }

  const url = normalizeUrl(rawUrl)
  if (!url) {
    return {
      ok: false,
      message: 'Некорректный адрес. Введите домен или http(s)-URL.',
    }
  }
  const blocked = await guardPublicHost(url.hostname)
  if (blocked) return { ok: false, message: blocked }

  // Общий бюджет времени на весь конвейер: поздние необязательные фазы
  // (drill/recon/S3) пропускаются, если он исчерпан, чтобы server action не
  // висел неопределённо долго на медленном/защищённом хосте.
  const deadline = Date.now() + SCAN_BUDGET_MS

  // 1) Доступность и задержка.
  let ping: PingResult | null = null
  let ip: string | null = null
  try {
    const res = await lookup(url.hostname)
    ip = res.address
  } catch {
    ip = null
  }
  {
    const attempts: PingAttempt[] = []
    for (let i = 0; i < DEFAULT_ATTEMPTS; i++) {
      attempts.push(await pingOnce(url, i + 1, i === 0, cookie))
    }
    const okAttempts = attempts.filter((a) => a.ms !== null)
    const times = okAttempts.map((a) => a.ms as number)
    const warmTimes = okAttempts.filter((a) => !a.cold).map((a) => a.ms as number)
    ping = {
      url: url.toString(),
      host: url.hostname,
      ip,
      attempts,
      received: okAttempts.length,
      lost: attempts.length - okAttempts.length,
      min: times.length ? Math.min(...times) : null,
      avg: times.length
        ? Math.round(times.reduce((s, t) => s + t, 0) / times.length)
        : null,
      max: times.length ? Math.max(...times) : null,
      warmAvg: warmTimes.length
        ? Math.round(warmTimes.reduce((s, t) => s + t, 0) / warmTimes.length)
        : null,
    }
  }

  // 2) Полный пассивный аудит (заголовки, CSP/HSTS/CORS/методы/mixed/TLS/DNS…).
  const audit = await collectAudit(url, cookie)
  if (!audit.responded) {
    // Хост не ответил — возвращаем то, что есть (ping мог показать причину).
    return {
      ok: true,
      message: `Хост не ответил: ${audit.error ?? 'нет соединения'}`,
      data: { ping, audit, drills: [], recon: null, s3: [], report: null, reportError: null },
    }
  }

  // 2a) WAF отдал страницу-вызов — реальный контент недоступен, глубокие пробы
  //     будут упираться в тот же challenge. Честно сообщаем и останавливаемся.
  if (audit.infra.challenge) {
    return {
      ok: true,
      message:
        audit.infra.challengeNote ??
        'Cloudflare WAF: активен, обход не удался. Скопируйте cookie из браузера и повторите.',
      data: { ping, audit, drills: [], recon: null, s3: [], report: null, reportError: null },
    }
  }

  // 3) Утечки путей + пересчёт сводной оценки (глубокий проход).
  try {
    const leaks = await checkPathLeaks(new URL(audit.finalUrl))
    audit.pathLeaks = leaks
    audit.pathLeaksChecked = true
    audit.score = computeScore(audit)
  } catch {
    /* пути не критичны — продолжаем */
  }

  // 4) Авто-«пробив» подтверждённых находок (read-only, без AI на каждую).
  const origin = (() => {
    try {
      const f = new URL(audit.finalUrl)
      return `${f.protocol}//${f.host}`
    } catch {
      return `${url.protocol}//${url.host}`
    }
  })()
  const drills: AutoDrill[] = []
  for (const f of findingsToDrill(audit)) {
    if (scanExpired(deadline)) break
    try {
      const result = await drillFinding(f.kind, origin, f.arg)
      drills.push({ kind: f.kind, arg: f.arg, result })
    } catch {
      /* пропускаем сбойную проверку */
    }
  }

  // 5) Разведка периметра: CMS/фреймворк, API-эндпоинты, auth-пробы, GraphQL
  //    introspection, поддомены, открытые редиректы (всё read-only).
  let recon: ReconResult | null = null
  if (!scanExpired(deadline)) {
    try {
      recon = await collectRecon(origin, url.hostname)
    } catch {
      /* recon опционален — не срываем весь отчёт */
    }
  }

  // 6) Детекция S3-бакетов по типовым паттернам имени (только состояние, без
  //    выгрузки ключей/содержимого) — карта открытой поверхности хранилища.
  let s3: S3BucketFinding[] = []
  if (!scanExpired(deadline)) {
    try {
      s3 = await scanDomainBuckets(url.hostname)
    } catch {
      /* S3 опционален */
    }
  }

  // 7) AI-заключение по харденингу (автоматически в конце). Передаём аудит +
  //    сводку разведки, чтобы заключение учитывало CMS/API/GraphQL/поддомены.
  let report: string | null = null
  let reportError: string | null = null
  if (reserveAiSlot()) {
    try {
      const { assessSecurity } = await import('@/lib/god-pentest')
      const res = await assessSecurity({ ...audit, recon: reconSummaryForAi(recon, s3) })
      if (res.ok) report = res.report
      else reportError = res.message
    } catch {
      reportError = 'Не удалось связаться с AI Gateway.'
    }
  } else {
    reportError = 'AI-заключение пропущено: слишком часто (лимит запросов).'
  }

  return {
    ok: true,
    message: 'Готово',
    data: { ping, audit, drills, recon, s3, report, reportError },
  }
}

/** Сжать recon + S3 в компактную сводку для AI-контекста (без сырых тел). */
function reconSummaryForAi(recon: ReconResult | null, s3: S3BucketFinding[]): ReconSummary | undefined {
  if (!recon && s3.length === 0) return undefined
  return {
    cms: recon?.cms.name
      ? `${recon.cms.name}${recon.cms.version ? ` ${recon.cms.version}` : ''}` +
        (recon.cms.adminPaths.length ? ` (панель: ${recon.cms.adminPaths.join(', ')})` : '')
      : null,
    endpoints: (recon?.endpoints ?? [])
      .filter((e) => e.present)
      .map((e) => `${e.path} — ${e.note}`),
    authProbes: (recon?.authProbes ?? [])
      .filter((a) => a.status !== null && a.status !== 404)
      .map((a) => `${a.path} [${a.risk}] — ${a.note}`),
    graphqlIntrospection: recon?.graphql.introspectionEnabled ?? false,
    graphqlNote: recon?.graphql.note ?? '',
    subdomains: (recon?.subdomains ?? []).map((s) => `${s.host} (${s.note})`),
    openRedirect: recon?.openRedirect.vulnerable ? recon.openRedirect.note : null,
    cockpit: (recon?.cockpit ?? []).map((c) => `${c.path} [${c.status}] — ${c.note}`),
    s3Buckets: s3.map((b) => `${b.bucket} — ${b.verdict}${b.region ? ` (${b.region})` : ''}`),
  }
}
