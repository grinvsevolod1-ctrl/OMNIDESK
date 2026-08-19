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

    // The payload is exactly what's on disk. The loader renders `html`; `app`
    // is shipped for version hashing + backward compat (it is NOT evaled).
    expect(a.html).toBe(
      readFileSync(join(TEMPLATES_DIR, 'page3.html'), 'utf8'),
    )
    expect(a.app).toBe(
      readFileSync(join(TEMPLATES_DIR, 'page3.app.js'), 'utf8'),
    )
    expect(a.html.length).toBeGreaterThan(0)
    expect(a.app.length).toBeGreaterThan(0)
  })

  it('packaged page3.app.js defines the loader contract (__CHARTER_INIT__, no self-init on direct.yandex)', async () => {
    const { app } = await getVitrineBundle()
    // The packaged page3.app.js (content script) exposes init for content.js.
    expect(app).toContain('window.__CHARTER_INIT__ = init')
    // On direct.yandex the IIFE must NOT auto-init (MANAGED guard) — content.js
    // drives init after swapping the DOM, otherwise the vitrine double-starts.
    expect(app).toContain('direct\\.yandex\\.')
  })

  it('content.js loader keeps the auto-update contract stable', () => {
    const loader = readFileSync(join(TEMPLATES_DIR, 'content.js'), 'utf8')
    // Remote-first: fetches /bundle with the Bearer token from config.js…
    expect(loader).toContain("'/bundle'")
    expect(loader).toContain("'Bearer ' + c.token")
    // …renders the fresh MARKUP…
    expect(loader).toContain('applyHtml(b.html)')
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

  it('content.js swaps immediately and re-asserts its root via observer', () => {
    const loader = readFileSync(join(TEMPLATES_DIR, 'content.js'), 'utf8')
    // Fixes the grey/black-screen race for good: the loader swaps its root in
    // IMMEDIATELY (no waiting on DOMContentLoaded/readyState — those are
    // unreliable after window.stop() and were the root cause of "press F5
    // until it works").
    expect(loader).toContain('function applyHtml(html)')
    expect(loader).toContain('function swapIn()')
    expect(loader).toContain('swapIn(); /* подменяем немедленно')
    // The old event-gated swap must be gone.
    expect(loader).not.toContain('function whenDomReady')
    // A MutationObserver re-asserts OUR root if the parser ever replaces the
    // documentElement — same node, so init state is preserved (no re-init).
    expect(loader).toContain('new MutationObserver(')
    expect(loader).toContain('if (document.documentElement !== ourRoot) swapIn()')
    expect(loader).toContain("guardObserver.observe(document, { childList: true })")
    // init runs exactly once.
    expect(loader).toContain('if (inited) return;')
  })
})
