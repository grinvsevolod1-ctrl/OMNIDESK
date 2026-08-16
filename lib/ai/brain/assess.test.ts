/**
 * Tests for the cheap escalation pre-filter: it gates the PAID model call in
 * detectEscalation, so false negatives here mean a real escalation is missed
 * and false positives mean wasted gateway spend on every turn.
 */
import { describe, expect, it } from 'vitest'
import { clientShowsEscalationSignal } from './assess'
import type { BrainMessage } from './core'

const client = (body: string): BrainMessage => ({ role: 'client', body })
const manager = (body: string): BrainMessage => ({ role: 'manager', body })

describe('clientShowsEscalationSignal', () => {
  it('is silent on an ordinary healthy dialog', () => {
    expect(
      clientShowsEscalationSignal([
        client('Здравствуйте, расскажите про условия'),
        manager('Конечно! Работаем удалённо, оплата еженедельно.'),
        client('А какой график?'),
        manager('Свободный, от 2 часов в день.'),
        client('Интересно, надо подумать'),
      ]),
    ).toBe(false)
  })

  it('fires on anger and insults', () => {
    expect(
      clientShowsEscalationSignal([
        client('Сколько можно?'),
        client('Вы меня уже достали своими вопросами'),
      ]),
    ).toBe(true)
  })

  it('fires on scam accusations and complaint threats', () => {
    expect(
      clientShowsEscalationSignal([
        client('Что-то это похоже на развод'),
        client('Напишу жалобу если не ответите нормально'),
      ]),
    ).toBe(true)
  })

  it('fires on an explicit demand for a human / operator', () => {
    expect(
      clientShowsEscalationSignal([
        client('Мне это не подходит'),
        client('Позовите живого человека'),
      ]),
    ).toBe(true)
    expect(
      clientShowsEscalationSignal([client('Ты бот что ли?'), client('Соедините с оператором')]),
    ).toBe(true)
  })

  it('fires when the client repeats the same message back to back (stuck dialog)', () => {
    expect(
      clientShowsEscalationSignal([
        client('Какая зарплата?'),
        manager('Зависит от графика, от 50 тысяч.'),
        client('Какая зарплата?'),
      ]),
    ).toBe(true)
  })

  it('does not treat ordinary words containing trigger substrings as signals', () => {
    // «человек» inside a normal sentence, «судя» containing «суд», etc.
    expect(
      clientShowsEscalationSignal([
        client('Я человек занятой, времени мало'),
        client('Судя по описанию, работа несложная'),
      ]),
    ).toBe(false)
  })

  it('only looks at CLIENT messages, not manager ones', () => {
    expect(
      clientShowsEscalationSignal([
        manager('Наш оператор скоро подключится'),
        client('Хорошо, жду'),
      ]),
    ).toBe(false)
  })

  it('is silent on empty history', () => {
    expect(clientShowsEscalationSignal([])).toBe(false)
  })
})
