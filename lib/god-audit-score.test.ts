import { describe, expect, it } from 'vitest'
import { computeScore, gradeFor, type ScoreInput } from './god-audit-score'

/**
 * Тесты сводной оценки защищённости (вкладка «Ping» god-панели).
 *
 * computeScore — чистая функция: старт 100, вычитаем баллы за недостатки.
 * Проверяем идеальный кейс, буквенные пороги, ключевые вычеты и клэмп в 0..100.
 */

/** Идеально защищённый домен: все проверки зелёные — ожидаем 100/A. */
function perfectInput(): ScoreInput {
  return {
    scheme: 'https',
    httpsUpgrade: 'yes',
    securityHeaders: [
      'strict-transport-security',
      'content-security-policy',
      'x-content-type-options',
      'x-frame-options',
      'referrer-policy',
      'permissions-policy',
    ].map((key) => ({ key, present: true })),
    disclosure: [],
    reflection: { risk: 'none' },
    tls: { tested: true, status: 'ok', note: '' },
    pathLeaks: [],
    cookies: [{ secure: true, httpOnly: true }],
    dns: {
      tested: true,
      spf: true,
      dmarc: true,
      dmarcPolicy: 'reject',
      caa: true,
    },
  }
}

describe('gradeFor', () => {
  it('раскладывает числа по буквенным порогам', () => {
    expect(gradeFor(100)).toBe('A')
    expect(gradeFor(90)).toBe('A')
    expect(gradeFor(89)).toBe('B')
    expect(gradeFor(80)).toBe('B')
    expect(gradeFor(70)).toBe('C')
    expect(gradeFor(55)).toBe('D')
    expect(gradeFor(40)).toBe('E')
    expect(gradeFor(39)).toBe('F')
    expect(gradeFor(0)).toBe('F')
  })
})

describe('computeScore', () => {
  it('идеальный домен получает 100/A без вычетов', () => {
    const r = computeScore(perfectInput())
    expect(r.value).toBe(100)
    expect(r.grade).toBe('A')
    expect(r.deductions).toEqual([])
  })

  it('снимает баллы за отсутствие HTTPS и апгрейда', () => {
    const input = perfectInput()
    input.scheme = 'http'
    input.httpsUpgrade = 'no'
    const r = computeScore(input)
    // −20 (нет HTTPS) −8 (нет апгрейда) = 72.
    expect(r.value).toBe(72)
    expect(r.deductions).toContainEqual({
      reason: 'Соединение без HTTPS',
      points: 20,
    })
    expect(r.deductions).toContainEqual({
      reason: 'Нет редиректа http→https',
      points: 8,
    })
  })

  it('высокий риск reflected XSS снимает 25 баллов', () => {
    const input = perfectInput()
    input.reflection = { risk: 'high' }
    const r = computeScore(input)
    expect(r.value).toBe(75)
    expect(r.deductions).toContainEqual({
      reason: 'Высокий риск reflected XSS',
      points: 25,
    })
  })

  it('открытый .env (critical) штрафуется как критичная утечка', () => {
    const input = perfectInput()
    input.pathLeaks = [{ exposed: true, severity: 'critical' }]
    const r = computeScore(input)
    expect(r.value).toBe(88)
    expect(r.deductions).toContainEqual({
      reason: 'Открыты критичные пути (.env/.git)',
      points: 12,
    })
  })

  it('info-путь (security.txt) не штрафуется', () => {
    const input = perfectInput()
    input.pathLeaks = [{ exposed: true, severity: 'info' }]
    const r = computeScore(input)
    expect(r.value).toBe(100)
  })

  it('плохой TLS снимает 25, предупреждение — 10', () => {
    const bad = perfectInput()
    bad.tls = { tested: true, status: 'bad', note: 'просрочен' }
    expect(computeScore(bad).value).toBe(75)

    const warn = perfectInput()
    warn.tls = { tested: true, status: 'warn', note: 'скоро истекает' }
    expect(computeScore(warn).value).toBe(90)
  })

  it('cookie без Secure/HttpOnly штрафуются (с потолком)', () => {
    const input = perfectInput()
    input.cookies = [
      { secure: false, httpOnly: false },
      { secure: true, httpOnly: false },
      { secure: false, httpOnly: true },
      { secure: false, httpOnly: false },
    ]
    const r = computeScore(input)
    // 4 плохих × 3 = 12, но потолок 9.
    expect(r.deductions).toContainEqual({
      reason: 'Cookie без Secure/HttpOnly',
      points: 9,
    })
  })

  it('DMARC policy=none даёт мягкий штраф, а полное отсутствие — больше', () => {
    const soft = perfectInput()
    soft.dns = { ...soft.dns, dmarcPolicy: 'none' }
    expect(computeScore(soft).deductions).toContainEqual({
      reason: 'DMARC policy=none',
      points: 2,
    })

    const none = perfectInput()
    none.dns = { ...none.dns, dmarc: false, dmarcPolicy: null }
    expect(computeScore(none).deductions).toContainEqual({
      reason: 'Нет DMARC-записи',
      points: 5,
    })
  })

  it('не проверенные DNS/TLS не штрафуются', () => {
    const input = perfectInput()
    input.tls = { tested: false, status: 'unknown', note: '' }
    input.dns = {
      tested: false,
      spf: false,
      dmarc: false,
      dmarcPolicy: null,
      caa: false,
    }
    // tested:false → эти блоки пропускаются, штрафов нет.
    expect(computeScore(input).value).toBe(100)
  })

  it('значение всегда в диапазоне 0..100', () => {
    const input: ScoreInput = {
      scheme: 'http',
      httpsUpgrade: 'no',
      securityHeaders: [],
      disclosure: [{ present: true }, { present: true }, { present: true }],
      reflection: { risk: 'high' },
      tls: { tested: true, status: 'bad', note: 'просрочен' },
      pathLeaks: [
        { exposed: true, severity: 'critical' },
        { exposed: true, severity: 'critical' },
        { exposed: true, severity: 'critical' },
        { exposed: true, severity: 'warn' },
      ],
      cookies: [{ secure: false, httpOnly: false }],
      dns: {
        tested: true,
        spf: false,
        dmarc: false,
        dmarcPolicy: null,
        caa: false,
      },
    }
    const r = computeScore(input)
    expect(r.value).toBeGreaterThanOrEqual(0)
    expect(r.value).toBeLessThanOrEqual(100)
    expect(r.grade).toBe('F')
  })
})
