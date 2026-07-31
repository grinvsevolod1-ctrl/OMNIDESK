import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// A valid 32-byte key as 64 hex chars, set BEFORE importing the module so the
// lazily-resolved key picks it up.
const HEX_KEY = 'a'.repeat(64)

let crypto: typeof import('./crypto')

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = HEX_KEY
  crypto = await import('./crypto')
})

afterAll(() => {
  delete process.env.ENCRYPTION_KEY
})

describe('encrypt/decrypt', () => {
  it('round-trips a UTF-8 string', () => {
    const plain = 'секретный токен 12345 — with unicode ✓'
    const envelope = crypto.encrypt(plain)
    expect(crypto.decrypt(envelope)).toBe(plain)
  })

  it('produces the versioned 4-part envelope format', () => {
    const envelope = crypto.encrypt('x')
    const parts = envelope.split('.')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('v1')
  })

  it('uses a fresh IV each time (ciphertext differs for same input)', () => {
    const a = crypto.encrypt('same-input')
    const b = crypto.encrypt('same-input')
    expect(a).not.toBe(b)
    expect(crypto.decrypt(a)).toBe(crypto.decrypt(b))
  })

  it('rejects a tampered ciphertext (GCM auth tag mismatch)', () => {
    const envelope = crypto.encrypt('do-not-tamper')
    const parts = envelope.split('.')
    // Flip a byte in the ciphertext segment.
    const data = Buffer.from(parts[3], 'base64')
    data[0] ^= 0xff
    parts[3] = data.toString('base64')
    expect(() => crypto.decrypt(parts.join('.'))).toThrow()
  })

  it('rejects an envelope with the wrong version prefix', () => {
    const envelope = crypto.encrypt('v')
    const parts = envelope.split('.')
    parts[0] = 'v2'
    expect(() => crypto.decrypt(parts.join('.'))).toThrow(
      /invalid ciphertext envelope/i,
    )
  })

  it('rejects a malformed envelope (wrong part count)', () => {
    expect(() => crypto.decrypt('v1.only.three')).toThrow()
  })

  it('round-trips JSON values', () => {
    const value = { a: 1, b: ['x', 'y'], c: { nested: true } }
    const envelope = crypto.encryptJson(value)
    expect(crypto.decryptJson(envelope)).toEqual(value)
  })
})

describe('maskSecret', () => {
  it('masks short secrets entirely', () => {
    expect(crypto.maskSecret('1234')).toBe('••••')
    expect(crypto.maskSecret('12345678')).toBe('••••')
  })

  it('shows a prefix and suffix for long secrets', () => {
    expect(crypto.maskSecret('123456789abcdef')).toBe('1234…cdef')
  })
})

describe('isEncryptionConfigured', () => {
  it('is true when ENCRYPTION_KEY is set', () => {
    expect(crypto.isEncryptionConfigured()).toBe(true)
  })
})
