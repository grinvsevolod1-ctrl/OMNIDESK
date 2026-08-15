import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildZip } from './zip'

/**
 * We validate the hand-rolled ZIP against a REAL unzip implementation (the
 * system `unzip`), not our own reader — that's the only way to be sure the
 * headers/CRC are spec-correct and Chrome will accept the archive. If `unzip`
 * is unavailable in the environment the round-trip test skips, but the
 * structural signature checks always run.
 */

let unzipAvailable = true
try {
  execFileSync('unzip', ['-v'], { stdio: 'ignore' })
} catch {
  unzipAvailable = false
}

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

describe('buildZip', () => {
  it('starts with the local-file-header signature and ends with EOCD', () => {
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('hello') }])
    // "PK\x03\x04"
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    // "PK\x05\x06" somewhere near the end (end of central directory)
    const eocd = zip.subarray(zip.length - 22)
    expect(eocd.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    // total-entries field == 1
    expect(eocd.readUInt16LE(10)).toBe(1)
  })

  it('records one central-directory entry per file', () => {
    const zip = buildZip([
      { name: 'a.txt', data: Buffer.from('aaaa') },
      { name: 'b/c.txt', data: Buffer.from('cccc') },
    ])
    const eocd = zip.subarray(zip.length - 22)
    expect(eocd.readUInt16LE(10)).toBe(2)
  })

  it.runIf(unzipAvailable)(
    'produces an archive a real unzip restores byte-for-byte',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'zip-test-'))
      tmpDirs.push(dir)
      // Include a large, highly-compressible payload + a tiny binary blob to
      // exercise both the DEFLATE and (potential) STORE paths.
      const big = Buffer.from('x'.repeat(50_000), 'utf8')
      const bin = Buffer.from([0, 1, 2, 3, 255, 254, 253])
      const unicode = Buffer.from('привет мир', 'utf8')
      const zip = buildZip([
        { name: 'manifest.json', data: unicode },
        { name: 'page.html', data: big },
        { name: 'icon.png', data: bin },
      ])
      const zipPath = join(dir, 'out.zip')
      writeFileSync(zipPath, zip)
      execFileSync('unzip', ['-o', zipPath, '-d', dir], { stdio: 'ignore' })
      expect(readFileSync(join(dir, 'manifest.json'))).toEqual(unicode)
      expect(readFileSync(join(dir, 'page.html'))).toEqual(big)
      expect(readFileSync(join(dir, 'icon.png'))).toEqual(bin)
    },
  )
})
