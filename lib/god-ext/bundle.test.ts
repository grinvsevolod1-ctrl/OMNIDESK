import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getVitrineBundle } from './bundle'

const TEMPLATES_DIR = join(process.cwd(), 'lib', 'god-ext', 'templates')

describe('getVitrineBundle (авто-обновление расширения)', () => {
  it('returns the current templates verbatim with a stable version hash', async () => {
    const a = await getVitrineBundle()
    const b = await getVitrineBundle()

    // Cached: identical object across calls, deterministic version.
    expect(b).toBe(a)
    expect(a.version).toMatch(/^[0-9a-f]{16}$/)

    // The payload is exactly what's on disk — the loader renders/evals it.
    expect(a.html).toBe(
      readFileSync(join(TEMPLATES_DIR, 'page3.html'), 'utf8'),
    )
    expect(a.app).toBe(
      readFileSync(join(TEMPLATES_DIR, 'page3.app.js'), 'utf8'),
    )
    expect(a.html.length).toBeGreaterThan(0)
    expect(a.app.length).toBeGreaterThan(0)
  })

  it('app payload defines the loader contract (__CHARTER_INIT__, no self-init on direct.yandex)', async () => {
    const { app } = await getVitrineBundle()
    // content.js evals the app and then calls window.__CHARTER_INIT__().
    expect(app).toContain('window.__CHARTER_INIT__ = init')
    // On direct.yandex the evaled IIFE must NOT auto-init (MANAGED guard) —
    // otherwise the vitrine would double-start after eval.
    expect(app).toContain('direct\\.yandex\\.')
  })

  it('content.js loader keeps the auto-update contract stable', () => {
    const loader = readFileSync(join(TEMPLATES_DIR, 'content.js'), 'utf8')
    // Remote-first: fetches /bundle with the Bearer token from config.js…
    expect(loader).toContain("'/bundle'")
    expect(loader).toContain("'Bearer ' + c.token")
    // …evals the fresh logic in the isolated world…
    expect(loader).toContain('(0, eval)(b.app)')
    // …and falls back to the packaged copy on any failure.
    expect(loader).toContain('loadRemote(function () { loadBundled(1); })')
    expect(loader).toContain('function loadBundled(attempt)')
  })
})
