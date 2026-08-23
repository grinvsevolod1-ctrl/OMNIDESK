import { describe, expect, it } from 'vitest'
import { validateWindow } from './traffic-sources'

/**
 * Окно дня источника трафика (миграция 145): [dayStart, dayEnd) в минутах
 * от полуночи МСК. Правила зеркалят CHECK-констрейнты таблицы
 * traffic_sources: границы в [0, 1440], начало строго раньше конца,
 * ночные окна через полночь (start > end) не поддерживаются сознательно.
 * getSourceStats в SQL использует то же полуоткрытое сравнение
 * (minute >= day_start AND minute < day_end) — эти тесты фиксируют
 * контракт валидации на стороне приложения.
 */
describe('validateWindow', () => {
  it('accepts the default window 09:00–18:00 (540–1080)', () => {
    expect(() => validateWindow(540, 1080)).not.toThrow()
  })

  it('accepts boundary windows within a single day', () => {
    expect(() => validateWindow(0, 1440)).not.toThrow() // весь день
    expect(() => validateWindow(0, 1)).not.toThrow() // минимальное окно
    expect(() => validateWindow(1439, 1440)).not.toThrow() // последняя минута
  })

  it('rejects empty and inverted windows (start >= end)', () => {
    expect(() => validateWindow(540, 540)).toThrow()
    expect(() => validateWindow(1080, 540)).toThrow() // ночь через полночь
  })

  it('rejects out-of-range starts', () => {
    expect(() => validateWindow(-1, 600)).toThrow()
    expect(() => validateWindow(1440, 1440)).toThrow() // start вне [0, 1440)
  })

  it('rejects out-of-range ends', () => {
    expect(() => validateWindow(0, 0)).toThrow() // end должен быть > 0
    expect(() => validateWindow(0, 1441)).toThrow() // end вне (0, 1440]
  })

  it('rejects non-integer minutes', () => {
    expect(() => validateWindow(540.5, 1080)).toThrow()
    expect(() => validateWindow(540, 1080.25)).toThrow()
    expect(() => validateWindow(Number.NaN, 1080)).toThrow()
  })
})
