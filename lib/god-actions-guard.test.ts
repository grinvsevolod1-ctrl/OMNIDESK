import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every exported god-panel server action is a standalone POST endpoint, so it
 * must enforce the passcode unlock itself — a bare `requireAdmin()` lets a
 * stolen admin cookie bypass the second factor. This parses each action file
 * and fails if an exported async function does not call one of the approved
 * guards before doing anything else.
 */

const DIR = join(__dirname, '..', 'app', 'actions', 'admin-secret')

/** gate.ts IS the unlock flow, so it can only require the admin session. */
const EXEMPT_FILES = new Set(['gate.ts', 'shared.ts'])

const GUARDS = [
  'requireGod()',
  'assertConsoleOrMessenger()',
  'assertGodOrMessenger()',
  // god-push.ts: local helper = messenger unlock OR requireAdmin + isGodUnlocked.
  'assertGod()',
  // gmt.ts: wrapper whose first line is `await requireGod()`.
  'runGmt(',
]

/**
 * Actions that intentionally run WITHOUT the god unlock.
 * stopImpersonationAction is called from inside an impersonated session, which
 * by construction never holds the god cookie; it only restores the stashed
 * admin session.
 */
const EXEMPT_ACTIONS = new Set(['stopImpersonationAction'])

/** Files whose local guard pairs requireAdmin() with isGodUnlocked(). */
const REQUIRE_ADMIN_WITH_UNLOCK = new Set(['god-push.ts'])

/** Each exported action's source, up to the next top-level export. */
function exportedActions(src: string): { name: string; body: string }[] {
  const re = /export async function (\w+)\s*\(/g
  const starts: { name: string; index: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) starts.push({ name: m[1], index: m.index })
  return starts.map(({ name, index }) => {
    const next = src.indexOf('\nexport ', index + 1)
    return { name, body: src.slice(index, next === -1 ? undefined : next) }
  })
}

describe('god-panel server actions', () => {
  const files = readdirSync(DIR).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !EXEMPT_FILES.has(f),
  )

  for (const file of files) {
    const src = readFileSync(join(DIR, file), 'utf8')
    if (!src.includes("'use server'")) continue

    it(`${file}: never guards with a bare requireAdmin()`, () => {
      if (REQUIRE_ADMIN_WITH_UNLOCK.has(file)) {
        expect(src).toMatch(/isGodUnlocked\(\)/)
        return
      }
      expect(src).not.toMatch(/await requireAdmin\(\)/)
    })

    for (const { name, body } of exportedActions(src)) {
      if (EXEMPT_ACTIONS.has(name)) continue
      it(`${file}: ${name} enforces the god unlock`, () => {
        expect(GUARDS.some((g) => body.includes(g))).toBe(true)
      })
    }
  }
})
