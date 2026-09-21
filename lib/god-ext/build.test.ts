import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { inflateRawSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { assembleExtensionZip, renderConfig, renderManifest, renderMarkup } from './build'

/** Walks the local headers our writer emits (no data descriptors, no ZIP64). */
function readZipEntries(zip: Buffer): Array<{ name: string; data: Buffer }> {
  const entries: Array<{ name: string; data: Buffer }> = []
  let offset = 0
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8)
    const compressedSize = zip.readUInt32LE(offset + 18)
    const nameLength = zip.readUInt16LE(offset + 26)
    const extraLength = zip.readUInt16LE(offset + 28)
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const bodyStart = offset + 30 + nameLength + extraLength
    const body = zip.subarray(bodyStart, bodyStart + compressedSize)
    entries.push({ name, data: method === 8 ? inflateRawSync(body) : Buffer.from(body) })
    offset = bodyStart + compressedSize
  }
  return entries
}

/** Cyrillic/punctuation UTF-8 bytes re-decoded as cp1252 ("Ð¿", "Ã©", "â€”"). */
const MOJIBAKE = /[\u00D0\u00D1][\u0080-\u00BF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013\u2014\u2018-\u201E\u2020-\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]|\u00C3[\u0080-\u00BF]|\u00E2\u20AC/

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

  it('ships every text file as clean UTF-8 without replacement characters or mojibake', async () => {
    const entries = readZipEntries(await assembleExtensionZip(params))
    const textEntries = entries.filter((entry) => !entry.name.endsWith('.png'))
    expect(textEntries.map((entry) => entry.name)).toEqual([
      'manifest.json', 'config.js', 'page3.markup.js', 'content.js',
      'background.js', 'page3.app.js', 'page3.html', 'rules.json',
    ])
    const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
    for (const entry of textEntries) {
      const text = strictUtf8.decode(entry.data)
      expect(text.charCodeAt(0), `${entry.name} starts with a BOM`).not.toBe(0xfeff)
      const replacement = text.indexOf('\uFFFD')
      expect(replacement, `${entry.name} has U+FFFD near: ${text.slice(Math.max(0, replacement - 40), replacement + 40)}`).toBe(-1)
      const mojibake = MOJIBAKE.exec(text)
      expect(mojibake, `${entry.name} has mojibake near: ${text.slice(Math.max(0, (mojibake?.index ?? 0) - 40), (mojibake?.index ?? 0) + 40)}`).toBeNull()
    }
    for (const entry of entries.filter((entry) => entry.name.endsWith('.png'))) {
      expect(entry.data.subarray(0, 4).toString('hex'), `${entry.name} is not a PNG`).toBe('89504e47')
    }
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
