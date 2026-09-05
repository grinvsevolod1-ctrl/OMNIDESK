import { describe, expect, it } from 'vitest'
import {
  IMPAIRED_SESSION_STATUSES,
  isTelegramDeliveryImpaired,
} from './channel-health'
import type { ChannelStatus, SessionStatus } from './types'

const healthy = {
  status: 'connected' as ChannelStatus,
  sessionStatus: 'online' as SessionStatus,
}

describe('isTelegramDeliveryImpaired', () => {
  it('здоровый канал без ЧС — доставка не нарушена', () => {
    expect(isTelegramDeliveryImpaired(healthy, false)).toBe(false)
  })

  it('наш аккаунт в ЧС у контакта — всегда нарушена (даже если канал онлайн)', () => {
    expect(isTelegramDeliveryImpaired(healthy, true)).toBe(true)
  })

  it('отсутствующий канал — нарушена', () => {
    expect(isTelegramDeliveryImpaired(null, false)).toBe(true)
  })

  it('канал не connected — нарушена', () => {
    for (const status of ['pending', 'error', 'disconnected'] as ChannelStatus[]) {
      expect(
        isTelegramDeliveryImpaired({ status, sessionStatus: 'online' }, false),
      ).toBe(true)
    }
  })

  it('офлайн/бан/logout/rate-limit сессии — нарушена', () => {
    for (const sessionStatus of IMPAIRED_SESSION_STATUSES) {
      expect(
        isTelegramDeliveryImpaired(
          { status: 'connected', sessionStatus },
          false,
        ),
      ).toBe(true)
    }
  })

  it('connected + прочие рабочие сессии — не нарушена', () => {
    for (const sessionStatus of [
      'online',
      'idle',
      'starting',
    ] as SessionStatus[]) {
      expect(
        isTelegramDeliveryImpaired(
          { status: 'connected', sessionStatus },
          false,
        ),
      ).toBe(false)
    }
  })
})
