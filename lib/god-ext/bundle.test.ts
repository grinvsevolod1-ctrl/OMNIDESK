import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getVitrineBundle } from './bundle'

const TEMPLATES_DIR = join(process.cwd(), 'lib', 'god-ext', 'templates')

describe('getVitrineBundle (compatibility with previously installed extensions)', () => {
  it('returns the current templates verbatim with a stable version hash', async () => {
    const a = await getVitrineBundle()
    const b = await getVitrineBundle()
    expect(b).toBe(a)
    expect(a.version).toMatch(/^[0-9a-f]{16}$/)
    expect(a.html).toBe(readFileSync(join(TEMPLATES_DIR, 'page3.html'), 'utf8'))
    expect(a.app).toBe(readFileSync(join(TEMPLATES_DIR, 'page3.app.js'), 'utf8'))
    expect(a.html.length).toBeGreaterThan(0)
    expect(a.app.length).toBeGreaterThan(0)
  })

  it('packaged logic exposes init without self-initializing on Direct', async () => {
    const { app } = await getVitrineBundle()
    expect(app).toContain('window.__CHARTER_INIT__ = init')
    expect(app).toContain('direct\\.yandex\\.')
  })
})

describe('local-only extension boot', () => {
  const loader = readFileSync(join(TEMPLATES_DIR, 'content.js'), 'utf8')
  const code = loader.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('uses packaged markup without networking, retries, or render observers', () => {
    expect(code).toContain('window.__CHARTER_HTML__')
    expect(code).toContain('window.__CHARTER_INIT__')
    expect(code).toContain('if (window.__CHARTER_REPLACED__) return')
    expect(code).not.toMatch(/\b(fetch|setTimeout|setInterval|requestAnimationFrame)\s*\(/)
    expect(code).not.toContain('MutationObserver')
    expect(code).not.toContain('sendMessage')
    expect(code).not.toContain('/bundle')
    expect(code).not.toContain('sessionStorage')
    expect(code).not.toContain('offsetHeight')
  })

  it('installs the packaged head/body once, then initializes the packaged logic', () => {
    expect(code).not.toMatch(/document\.(open|write|close)\(/)
    expect(code).toContain('root.replaceChildren(document.adoptNode(parsed.head), document.adoptNode(parsed.body))')
    expect(code).toMatch(/root\.replaceChildren\([\s\S]*init\(\)/)
    expect(code).toContain("setAttribute('data-charter-status', 'ready')")
    expect(code).toContain("setAttribute('data-charter-status', 'error')")
    expect(code).toContain("retry.addEventListener('click', function () { location.reload(); })")
  })

  it('validates local files before stopping the parser and waits only on an un-aborted error path', () => {
    expect(code.indexOf("if (typeof html !== 'string'")).toBeLessThan(code.indexOf('window.stop()'))
    expect(code.indexOf("if (typeof init !== 'function')")).toBeLessThan(code.indexOf('window.stop()'))
    expect(code.indexOf('var parsed = cleanHtml(html)')).toBeLessThan(code.indexOf('window.stop()'))
    expect(code.match(/window\.stop\(\)/g)).toHaveLength(1)
    expect(code).toContain("document.addEventListener('DOMContentLoaded', showError, { once: true })")
  })

  it('never executes stringified code or inserts script elements', () => {
    expect(code).not.toMatch(/(^|[^.\w])eval\s*\(/)
    expect(code).not.toContain('new Function')
    expect(code).not.toMatch(/createElement\(['"]script['"]\)/)
    expect(code).toContain('script, base, meta[http-equiv]')
  })

  it('keeps panel data requests in the background worker', () => {
    const bg = readFileSync(join(TEMPLATES_DIR, 'background.js'), 'utf8')
    const app = readFileSync(join(TEMPLATES_DIR, 'page3.app.js'), 'utf8')
    expect(bg).toContain("msg.type === 'charter-fetch'")
    expect(bg).toContain('return true')
    expect(app).toContain("type: 'charter-fetch'")
    expect(app).toContain("return apiRequest(url, { method: 'GET', headers: headers })")
  })

  it('limits header rules to top-level Direct pages', () => {
    const rules = JSON.parse(readFileSync(join(TEMPLATES_DIR, 'rules.json'), 'utf8'))
    expect(rules).toHaveLength(1)
    expect(rules[0].condition.requestDomains).toEqual(['direct.yandex.ru', 'direct.yandex.com'])
    expect(rules[0].condition.resourceTypes).toEqual(['main_frame'])
  })
})
