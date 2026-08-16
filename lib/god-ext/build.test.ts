import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { assembleExtensionZip, renderConfig, renderManifest } from './build'

let unzipAvailable = true
try {
  execFileSync('unzip', ['-v'], { stdio: 'ignore' })
} catch {
  unzipAvailable = false
}

describe('renderConfig', () => {
  it('injects api base, page and token, pageUrl empty (bundled html)', () => {
    const js = renderConfig({
      apiBase: 'https://panel.example.com/api/ext',
      page: 'accc',
      token: 'secret-token',
    })
    expect(js).toContain(`api: "https://panel.example.com/api/ext"`)
    expect(js).toContain(`page: "accc"`)
    expect(js).toContain(`token: "secret-token"`)
    expect(js).toContain(`pageUrl: ''`)
    expect(js).toContain('debug: false')
  })

  it('escapes values so a hostile token cannot break out of the string', () => {
    const js = renderConfig({ apiBase: 'x', page: 'p', token: 'a";evil()//' })
    expect(js).toContain(JSON.stringify('a";evil()//'))
  })
})

describe('renderManifest', () => {
  it('produces valid MV3 JSON with unique name/version and panel origin', () => {
    const m = JSON.parse(
      renderManifest({
        name: 'яндекс 11',
        version: '1.0.3',
        origin: 'https://panel.example.com',
      }),
    )
    expect(m.manifest_version).toBe(3)
    expect(m.name).toBe('яндекс 11')
    expect(m.version).toBe('1.0.3')
    expect(m.host_permissions).toContain('https://panel.example.com/*')
    expect(m.host_permissions).toContain('https://*.yandex.ru/*')
    // The old hardcoded panel domain must be gone.
    expect(m.host_permissions).not.toContain('https://charter-panel.com/*')
    expect(m.content_scripts[0].js).toEqual([
      'config.js',
      'page3.app.js',
      'content.js',
    ])
    expect(m.icons).toEqual({
      '32': 'icon32.png',
      '48': 'icon48.png',
      '128': 'icon128.png',
    })
  })
})

describe('assembleExtensionZip', () => {
  const tmpDirs: string[] = []
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  })

  it('starts with the ZIP local-header signature', async () => {
    const zip = await assembleExtensionZip({
      origin: 'https://panel.example.com/',
      slug: 'accc',
      token: 'tok123',
      name: 'яндекс 11',
      version: '1.0.1',
    })
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  })

  it.runIf(unzipAvailable)(
    'unzips to generated config/manifest + all static templates',
    async () => {
      const zip = await assembleExtensionZip({
        origin: 'https://panel.example.com/',
        slug: 'accc',
        token: 'tok123',
        name: 'яндекс 11',
        version: '1.0.1',
      })
      const dir = mkdtempSync(join(tmpdir(), 'ext-zip-'))
      tmpDirs.push(dir)
      const zipPath = join(dir, 'ext.zip')
      writeFileSync(zipPath, zip)
      execFileSync('unzip', ['-o', zipPath, '-d', dir], { stdio: 'ignore' })

      const manifest = JSON.parse(
        readFileSync(join(dir, 'manifest.json'), 'utf8'),
      )
      expect(manifest.name).toBe('яндекс 11')
      expect(manifest.version).toBe('1.0.1')

      const config = readFileSync(join(dir, 'config.js'), 'utf8')
      // trailing slash on origin is stripped before "/api/ext"
      expect(config).toContain('"https://panel.example.com/api/ext"')
      expect(config).toContain('"accc"')
      expect(config).toContain('"tok123"')

      for (const f of [
        'content.js',
        'page3.app.js',
        'page3.html',
        'rules.json',
        'icon32.png',
        'icon48.png',
        'icon128.png',
      ]) {
        expect(readFileSync(join(dir, f)).length).toBeGreaterThan(0)
      }
    },
  )
})
