import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'node:crypto'
import { env } from './env.js'

/**
 * AES-256-GCM encryption — byte-for-byte compatible with the panel's
 * lib/crypto.ts so both services read/write the same encrypted envelopes.
 * Envelope format: v1.<iv>.<tag>.<ciphertext> (each base64).
 */

const VERSION = 'v1'

function resolveKey(): Buffer {
  const raw = env.encryptionKey
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
  try {
    const b = Buffer.from(raw, 'base64')
    if (b.length === 32) return b
  } catch {
    /* fall through */
  }

  // Refuse to stretch a weak/malformed key in production — it must match the
  // panel's key exactly and be a real 32-byte value, otherwise encrypted
  // channel secrets are protected by a guessable key.
  if (env.nodeEnv === 'production') {
    throw new Error(
      'ENCRYPTION_KEY is weak or malformed. Provide a 32-byte key as 64 hex ' +
        'chars (openssl rand -hex 32) or base64 (openssl rand -base64 32). ' +
        'It MUST be identical to the panel.',
    )
  }
  return createHash('sha256').update(raw).digest()
}

let cachedKey: Buffer | null = null
function key(): Buffer {
  if (!cachedKey) cachedKey = resolveKey()
  return cachedKey
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.')
}

export function decrypt(envelope: string): string {
  const parts = envelope.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Invalid ciphertext envelope')
  }
  const [, ivB64, tagB64, dataB64] = parts
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key(),
    Buffer.from(ivB64, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ])
  return plaintext.toString('utf8')
}

export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value))
}

export function decryptJson<T = unknown>(envelope: string): T {
  return JSON.parse(decrypt(envelope)) as T
}
