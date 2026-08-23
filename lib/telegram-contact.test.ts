import { describe, expect, it } from 'vitest'
import { normalizeTelegramContact } from './telegram-contact'

describe('normalizeTelegramContact', () => {
  it('принимает @username', () => {
    expect(normalizeTelegramContact('@ivan_hr')).toBe('@ivan_hr')
  })

  it('принимает голый username без @', () => {
    expect(normalizeTelegramContact('ivan_hr')).toBe('@ivan_hr')
  })

  it('принимает t.me-ссылки во всех вариантах', () => {
    expect(normalizeTelegramContact('t.me/ivan_hr')).toBe('@ivan_hr')
    expect(normalizeTelegramContact('https://t.me/ivan_hr')).toBe('@ivan_hr')
    expect(normalizeTelegramContact('http://www.t.me/ivan_hr')).toBe('@ivan_hr')
    expect(normalizeTelegramContact('telegram.me/ivan_hr')).toBe('@ivan_hr')
  })

  it('отбрасывает хвосты ссылки', () => {
    expect(normalizeTelegramContact('https://t.me/ivan_hr?start=abc')).toBe(
      '@ivan_hr',
    )
    expect(normalizeTelegramContact('t.me/ivan_hr/123')).toBe('@ivan_hr')
  })

  it('обрезает пробелы', () => {
    expect(normalizeTelegramContact('  @ivan_hr  ')).toBe('@ivan_hr')
  })

  it('отклоняет невалидные значения', () => {
    expect(normalizeTelegramContact('')).toBeNull()
    expect(normalizeTelegramContact('   ')).toBeNull()
    expect(normalizeTelegramContact('@abc')).toBeNull() // короче 5
    expect(normalizeTelegramContact('иван')).toBeNull() // кириллица
    expect(normalizeTelegramContact('a'.repeat(33))).toBeNull() // длиннее 32
    expect(normalizeTelegramContact('t.me/')).toBeNull()
  })
})
