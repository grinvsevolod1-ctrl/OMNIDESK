import { describe, expect, it } from 'vitest'
import { toManager } from './shared-converters'
import type { ManagerRow } from './shared'
import type { AccountRole } from '../types'

/**
 * Regression tests for the row → Manager converter.
 *
 * The `role` mapping here is load-bearing: it is what the login flow signs
 * into the session, and a role that falls through to the wrong default sends
 * the user to the wrong dashboard. A real bug shipped where `buyer` (migration
 * 145) was missing from this switch and every buyer silently logged in as a
 * `manager` — these tests lock the full 5-role mapping and the role-conditional
 * fields (curator city/telegram, head edit permission) in place.
 */

function row(overrides: Partial<ManagerRow> = {}): ManagerRow {
  return {
    id: 'm1',
    name: 'Иван Иванов',
    email: 'ivan@omnidesk.test',
    username: null,
    password_hash: 'x',
    status: 'active',
    session_version: 1,
    on_lunch: null,
    role: null,
    city: null,
    head_can_edit: null,
    telegram_contact: null,
    avatar_url: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('toManager role mapping', () => {
  it('maps every known role to itself', () => {
    for (const role of ['curator', 'head', 'buyer'] as AccountRole[]) {
      expect(toManager(row({ role })).role).toBe(role)
    }
  })

  it('maps explicit manager role to manager', () => {
    expect(toManager(row({ role: 'manager' })).role).toBe('manager')
  })

  it('defaults null/unknown role to manager (never to a privileged role)', () => {
    expect(toManager(row({ role: null })).role).toBe('manager')
    // Anything unrecognized must degrade to the least-privileged role.
    expect(
      toManager(row({ role: 'nonsense' as AccountRole })).role,
    ).toBe('manager')
  })

  it('REGRESSION: buyer must not fall through to manager', () => {
    // The exact bug: buyer role dropped to 'manager', routing buyers to the
    // manager dashboard instead of their read-only /buyer section.
    expect(toManager(row({ role: 'buyer' })).role).toBe('buyer')
  })
})

describe('toManager role-conditional fields', () => {
  it('exposes city only for curators', () => {
    expect(toManager(row({ role: 'curator', city: 'Москва' })).city).toBe(
      'Москва',
    )
    expect(toManager(row({ role: 'manager', city: 'Москва' })).city).toBeNull()
    expect(toManager(row({ role: 'buyer', city: 'Москва' })).city).toBeNull()
  })

  it('exposes telegramContact only for curators', () => {
    expect(
      toManager(row({ role: 'curator', telegram_contact: '@kuz' }))
        .telegramContact,
    ).toBe('@kuz')
    expect(
      toManager(row({ role: 'manager', telegram_contact: '@kuz' }))
        .telegramContact,
    ).toBeNull()
  })

  it('exposes headCanEdit only for heads', () => {
    expect(
      toManager(row({ role: 'head', head_can_edit: true })).headCanEdit,
    ).toBe(true)
    expect(
      toManager(row({ role: 'head', head_can_edit: false })).headCanEdit,
    ).toBe(false)
    // Non-heads never carry an edit permission, even if the column is set.
    expect(
      toManager(row({ role: 'manager', head_can_edit: true })).headCanEdit,
    ).toBe(false)
  })
})

describe('toManager scalar fields', () => {
  it('normalizes nullable columns and serializes createdAt to ISO', () => {
    const m = toManager(
      row({
        username: null,
        on_lunch: null,
        avatar_url: null,
        created_at: new Date('2026-03-04T05:06:07.000Z'),
      }),
    )
    expect(m.username).toBeNull()
    expect(m.onLunch).toBe(false)
    expect(m.avatarUrl).toBeNull()
    expect(m.createdAt).toBe('2026-03-04T05:06:07.000Z')
  })

  it('passes through set optional fields', () => {
    const m = toManager(
      row({ username: 'ivan', on_lunch: true, avatar_url: 'data:image/png,x' }),
    )
    expect(m.username).toBe('ivan')
    expect(m.onLunch).toBe(true)
    expect(m.avatarUrl).toBe('data:image/png,x')
  })
})
