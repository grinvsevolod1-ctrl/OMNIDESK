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
    // …renders the fresh MARKUP…
    expect(loader).toContain('render(b.html)')
    // …and falls back to the packaged copy on any failure.
    expect(loader).toContain('loadRemote(function () { loadBundled(1); })')
    expect(loader).toContain('function loadBundled(attempt)')
  })

  it('content.js NEVER evals remote logic (MV3 CSP forbids it)', () => {
    const loader = readFileSync(join(TEMPLATES_DIR, 'content.js'), 'utf8')
    // The old eval path caused the console CSP error and unreliable startup.
    // Strip line/block comments first so mentions of "eval" in the docs that
    // EXPLAIN why we don't eval don't trip the guard — only real calls do.
    const code = loader
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    // No string-execution primitives anywhere in executable code.
    expect(code).not.toMatch(/(^|[^.\w])eval\s*\(/)
    expect(code).not.toMatch(/\(\s*0\s*,\s*eval\s*\)/)
    expect(code).not.toContain('new Function')
    expect(code).not.toContain('b.app')
    // Logic comes from the packaged page3.app.js via __CHARTER_INIT__.
    expect(loader).toContain('window.__CHARTER_INIT__()')
  })

  it('content.js swaps the document only AFTER the parser is done', () => {
    const loader = readFileSync(join(TEMPLATES_DIR, 'content.js'), 'utf8')
    // Fixes the grey-screen race: replaceDocument runs from render(), which
    // waits for readyState !== 'loading' / DOMContentLoaded before swapping.
    expect(loader).toContain('function whenDomReady(cb)')
    expect(loader).toContain("document.readyState !== 'loading'")
    expect(loader).toContain("document.addEventListener('DOMContentLoaded'")
    // render() is the single gate feeding replaceDocument.
    expect(loader).toContain('function render(html)')
    expect(loader).toContain('whenDomReady(function () {')
  })
})
