import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterAll, describe, expect, it } from 'vitest'
import { assembleExtensionZip, renderConfig, renderManifest, renderMarkup } from './build'

let unzipAvailable = true
try {
  execFileSync('unzip', ['-v'], { stdio: 'ignore' })
} catch {
  unzipAvailable = false
}

describe('renderConfig', () => {
  it('injects api base, page and token with data-only polling', () => {
    const js = renderConfig({
      apiBase: 'https://panel.example.com/api/ext',
      page: 'accc',
      token: 'secret-token',
    })
    expect(js).toContain(`api: "https://panel.example.com/api/ext"`)
    expect(js).toContain(`page: "accc"`)
    expect(js).toContain(`token: "secret-token"`)
    expect(js).not.toContain('pageUrl')
    expect(js).toContain("transport: 'poll'")
    expect(js).toContain('debug: false')
  })

  it('escapes values so a hostile token cannot break out of the string', () => {
    const js = renderConfig({ apiBase: 'x', page: 'p', token: 'a";evil()//' })
    expect(js).toContain(JSON.stringify('a";evil()//'))
  })
})

describe('renderMarkup', () => {
  it('preserves HTML as inert data, including quotes and Unicode separators', () => {
    const html = '<html lang="ru"><body>Тест</body></html>\n";evil()//\u2028\u2029'
    const sandbox = { window: { __CHARTER_HTML__: '' } }
    runInNewContext(renderMarkup(html), sandbox)
    expect(sandbox.window.__CHARTER_HTML__).toBe(html)
  })
})

describe('renderManifest', () => {
  it('produces valid MV3 JSON with unique name/version and narrow permissions', () => {
    const m = JSON.parse(renderManifest({
      name: 'яндекс 11', version: '1.0.3', origin: 'https://panel.example.com',
    }))
    expect(m.manifest_version).toBe(3)
    expect(m.name).toBe('яндекс 11')
    expect(m.version).toBe('1.0.3')
    expect(m.host_permissions).toEqual([
      'https://panel.example.com/*',
      'https://direct.yandex.ru/*',
      'https://direct.yandex.com/*',
    ])
    expect(m.permissions).toEqual(['declarativeNetRequestWithHostAccess'])
    expect(m.web_accessible_resources).toBeUndefined()
    expect(m.content_scripts[0].run_at).toBe('document_start')
    expect(m.content_scripts[0].js).toEqual([
      'config.js', 'page3.markup.js', 'page3.app.js', 'content.js',
    ])
    expect(m.icons).toEqual({ '32': 'icon32.png', '48': 'icon48.png', '128': 'icon128.png' })
  })
})

describe('assembleExtensionZip', () => {
  const tmpDirs: string[] = []
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  })

  const params = {
    origin: 'https://panel.example.com/', slug: 'accc', token: 'tok123',
    name: 'яндекс 11', version: '1.0.1',
  }

  it('starts with the ZIP local-header signature', async () => {
    const zip = await assembleExtensionZip(params)
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  })

  it.runIf(unzipAvailable)('unzips to complete, matching config/manifest/markup and templates', async () => {
    const zip = await assembleExtensionZip(params)
    const dir = mkdtempSync(join(tmpdir(), 'ext-zip-'))
    tmpDirs.push(dir)
    const zipPath = join(dir, 'ext.zip')
    writeFileSync(zipPath, zip)
    execFileSync('unzip', ['-o', zipPath, '-d', dir], { stdio: 'ignore' })

    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    expect(manifest.name).toBe('яндекс 11')
    expect(manifest.version).toBe('1.0.1')
    const config = readFileSync(join(dir, 'config.js'), 'utf8')
    expect(config).toContain('"https://panel.example.com/api/ext"')
    expect(config).toContain('"accc"')
    expect(config).toContain('"tok123"')
    const sandbox = { window: { __CHARTER_HTML__: '' } }
    runInNewContext(readFileSync(join(dir, 'page3.markup.js'), 'utf8'), sandbox)
    expect(sandbox.window.__CHARTER_HTML__).toBe(readFileSync(join(dir, 'page3.html'), 'utf8'))

    for (const f of [
      'content.js', 'background.js', 'page3.markup.js', 'page3.app.js', 'page3.html',
      'rules.json', 'icon32.png', 'icon48.png', 'icon128.png',
    ]) {
      expect(readFileSync(join(dir, f)).length).toBeGreaterThan(0)
    }
  })
})
