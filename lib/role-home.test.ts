import { describe, expect, it } from 'vitest'
import { roleHome } from './auth'
import type { SessionUser } from './types/accounts'

/**
 * roleHome is the single source of truth for where each role lands, used by
 * every require*-guard to redirect a mismatched role back to its own section.
 *
 * This is the downstream half of the buyer bug: even with the role mapped
 * correctly out of the DB, a wrong entry here would strand a role on the wrong
 * dashboard. Locks the full 5-role table plus the safe /login fallback.
 */
describe('roleHome', () => {
  const cases: Array<[SessionUser['role'], string]> = [
    ['admin', '/admin'],
    ['manager', '/app'],
    ['curator', '/curator'],
    ['head', '/head'],
    ['buyer', '/buyer'],
  ]

  it.each(cases)('routes %s to %s', (role, home) => {
    expect(roleHome(role)).toBe(home)
  })

  it('every role maps to a distinct home (no two roles collide)', () => {
    const homes = cases.map(([, home]) => home)
    expect(new Set(homes).size).toBe(homes.length)
  })

  it('falls back to /login for an unknown role', () => {
    expect(roleHome('nonsense' as SessionUser['role'])).toBe('/login')
  })
})
