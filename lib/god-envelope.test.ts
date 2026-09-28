import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  GOD_ENVELOPE_PREFIX,
  deriveGodKey,
  isGodSealed,
  openWith,
  sealWith,
} from './god-envelope'

const key = deriveGodKey(randomBytes(32))

describe('god envelope', () => {
  it('round-trips unicode text', () => {
    const plain = 'Привет, группа подработок! 🚀 @handle'
    const sealed = sealWith(key, plain)
    expect(sealed.startsWith(GOD_ENVELOPE_PREFIX)).toBe(true)
    expect(sealed).not.toContain('Привет')
    expect(openWith(key, sealed)).toBe(plain)
  })

  it('uses a random IV per seal', () => {
    expect(sealWith(key, 'same')).not.toBe(sealWith(key, 'same'))
  })

  it('is idempotent and passes legacy plaintext through', () => {
    const sealed = sealWith(key, 'x')
    expect(sealWith(key, sealed)).toBe(sealed)
    expect(openWith(key, 'legacy plaintext')).toBe('legacy plaintext')
    expect(sealWith(key, '')).toBe('')
    expect(isGodSealed('legacy')).toBe(false)
  })

  it('rejects tampering and the wrong key', () => {
    const sealed = sealWith(key, 'secret')
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + '='
    expect(() => openWith(key, tampered)).toThrow()
    expect(() => openWith(deriveGodKey(randomBytes(32)), sealed)).toThrow()
  })

  it('derives a key distinct from the master key', () => {
    const master = randomBytes(32)
    expect(deriveGodKey(master).equals(master)).toBe(false)
    expect(deriveGodKey(master).equals(deriveGodKey(master))).toBe(true)
  })
})
