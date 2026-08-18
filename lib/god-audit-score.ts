/**
 * Сводная оценка защищённости для god-панели (вкладка «Ping»).
 *
 * Вынесено из server-action `app/actions/admin-secret/ping.ts` в отдельный
 * модуль по двум причинам:
 *   1) файл с 'use server' может экспортировать только async-функции, а это
 *      чистая синхронная функция;
 *   2) чистую функцию удобно покрывать юнит-тестами без сети и гейтов.
 *
 * Часть скрытой панели (AGENTS.md §4): модуль НЕ импортируется из lib/ai-console/*.
 * Здесь нет никакой логики атак — только подсчёт баллов по уже собранным
 * пассивным сигналам.
 */

/** Итоговая оценка защищённости домена. */
export interface SecurityScore {
  /** 0–100. */
  value: number
  /** Буквенная оценка A–F. */
  grade: 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
  /** Разбивка снятых баллов: причина → сколько снято. */
  deductions: { reason: string; points: number }[]
}

/**
 * Структурный (минимальный) вход для подсчёта. Полный `SecurityAudit` из
 * ping.ts структурно ему соответствует, поэтому передаётся напрямую.
 */
export interface ScoreInput {
  scheme: string
  httpsUpgrade: 'yes' | 'no' | 'unknown'
  securityHeaders: { key: string; present: boolean }[]
  disclosure: { present: boolean }[]
  reflection: { risk: 'none' | 'low' | 'medium' | 'high' }
  tls: { tested: boolean; status: 'ok' | 'warn' | 'bad' | 'unknown'; note: string }
  pathLeaks: { exposed: boolean; severity: 'critical' | 'warn' | 'info' }[]
  cookies: { secure: boolean; httpOnly: boolean }[]
  dns: {
    tested: boolean
    spf: boolean
    dmarc: boolean
    dmarcPolicy: string | null
    caa: boolean
  }
}

/** Присутствует ли заголовок безопасности по ключу. */
function headerPresent(input: ScoreInput, key: string): boolean {
  return input.securityHeaders.some((h) => h.key === key && h.present)
}

/** Буквенная оценка по числовому значению. */
export function gradeFor(value: number): SecurityScore['grade'] {
  if (value >= 90) return 'A'
  if (value >= 80) return 'B'
  if (value >= 70) return 'C'
  if (value >= 55) return 'D'
  if (value >= 40) return 'E'
  return 'F'
}

/**
 * Вычислить сводную оценку: старт 100, вычитаем баллы за недостатки.
 * Чистая функция — детерминированная и легко тестируемая.
 */
export function computeScore(input: ScoreInput): SecurityScore {
  const deductions: { reason: string; points: number }[] = []
  const cut = (reason: string, points: number) => {
    if (points > 0) deductions.push({ reason, points })
  }

  // Транспорт.
  if (input.scheme !== 'https') cut('Соединение без HTTPS', 20)
  if (input.httpsUpgrade === 'no') cut('Нет редиректа http→https', 8)

  // Заголовки безопасности.
  if (!headerPresent(input, 'strict-transport-security'))
    cut('Нет HSTS (Strict-Transport-Security)', 10)
  if (!headerPresent(input, 'content-security-policy'))
    cut('Нет Content-Security-Policy', 12)
  if (!headerPresent(input, 'x-content-type-options'))
    cut('Нет X-Content-Type-Options', 5)
  if (!headerPresent(input, 'x-frame-options')) cut('Нет X-Frame-Options', 5)
  if (!headerPresent(input, 'referrer-policy')) cut('Нет Referrer-Policy', 3)
  if (!headerPresent(input, 'permissions-policy'))
    cut('Нет Permissions-Policy', 3)

  // Раскрытие версий ПО.
  if (input.disclosure.length > 0)
    cut(
      'Раскрытие версий ПО в заголовках',
      Math.min(input.disclosure.length * 3, 9),
    )

  // Reflected XSS.
  if (input.reflection.risk === 'high') cut('Высокий риск reflected XSS', 25)
  else if (input.reflection.risk === 'medium')
    cut('Средний риск reflected XSS', 15)
  else if (input.reflection.risk === 'low')
    cut('Отражение ввода (низкий риск)', 5)

  // TLS.
  if (input.tls.tested) {
    if (input.tls.status === 'bad') cut(`TLS: ${input.tls.note}`, 25)
    else if (input.tls.status === 'warn') cut(`TLS: ${input.tls.note}`, 10)
  }

  // Утечки путей.
  const critical = input.pathLeaks.filter(
    (p) => p.exposed && p.severity === 'critical',
  ).length
  const warn = input.pathLeaks.filter(
    (p) => p.exposed && p.severity === 'warn',
  ).length
  if (critical > 0)
    cut('Открыты критичные пути (.env/.git)', Math.min(critical * 12, 30))
  if (warn > 0) cut('Открыты чувствительные пути', Math.min(warn * 5, 15))

  // Cookie без флагов.
  const badCookies = input.cookies.filter(
    (c) => !c.secure || !c.httpOnly,
  ).length
  if (badCookies > 0)
    cut('Cookie без Secure/HttpOnly', Math.min(badCookies * 3, 9))

  // DNS/почта.
  if (input.dns.tested) {
    if (!input.dns.spf) cut('Нет SPF-записи', 4)
    if (!input.dns.dmarc) cut('Нет DMARC-записи', 5)
    else if (input.dns.dmarcPolicy === 'none') cut('DMARC policy=none', 2)
    if (!input.dns.caa) cut('Нет CAA-записи', 2)
  }

  const totalCut = deductions.reduce((s, d) => s + d.points, 0)
  const value = Math.max(0, Math.min(100, 100 - totalCut))
  return { value, grade: gradeFor(value), deductions }
}
