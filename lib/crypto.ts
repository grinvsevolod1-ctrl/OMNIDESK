import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'crypto'

/**
 * Application-level encryption for secrets at rest (Telegram string sessions,
 * WhatsApp auth state, proxy credentials, API tokens).
 *
 * Algorithm: AES-256-GCM. The key comes from the ENCRYPTION_KEY env var.
 * Accepts a 64-char hex string, a base64 string decoding to 32 bytes, or any
 * other string (which is hashed to 32 bytes with SHA-256 as a fallback so the
 * app never crashes on a weak key — though a proper 32-byte key is required in
 * production).
 *
 * Stored format (single base64 string):  v1.<iv>.<tag>.<ciphertext>
 * where iv/tag/ciphertext are each base64. The "v1" prefix lets us rotate the
 * scheme later without ambiguity.
 */

const VERSION = 'v1'

function resolveKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32',
    )
  }
  // 64-char hex -> 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex')
  }
  // base64 decoding to exactly 32 bytes
  try {
    const b = Buffer.from(raw, 'base64')
    if (b.length === 32) return b
  } catch {
    // fall through
  }

  // The value is neither 32-byte hex nor 32-byte base64. In production we refuse
  // to silently stretch a low-entropy string into a key — that would encrypt
  // Telegram sessions / proxy credentials under a guessable key. Fail fast so
  // the operator generates a proper key.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'ENCRYPTION_KEY is weak or malformed. Provide a 32-byte key as 64 hex ' +
        'chars (openssl rand -hex 32) or base64 (openssl rand -base64 32).',
    )
  }

  // Dev only: derive a stable 32-byte key from whatever was provided so the app
  // still boots locally, but warn loudly.
  console.warn(
    '[crypto] ENCRYPTION_KEY is not a proper 32-byte key — deriving one via ' +
      'SHA-256 (DEV ONLY). Generate a real key with `openssl rand -hex 32`.',
  )
  return createHash('sha256').update(raw).digest()
}

let cachedKey: Buffer | null = null
function key(): Buffer {
  if (!cachedKey) cachedKey = resolveKey()
  return cachedKey
}

/** Encrypt a UTF-8 string. Returns a portable base64 envelope string. */
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

/** Decrypt an envelope produced by encrypt(). Throws on tampering. */
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

/** Encrypt a JSON-serializable value. */
export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value))
}

/** Decrypt to a typed JSON value. */
export function decryptJson<T = unknown>(envelope: string): T {
  return JSON.parse(decrypt(envelope)) as T
}

/** True when ENCRYPTION_KEY is present (used to gate encrypted features). */
export function isEncryptionConfigured(): boolean {
  return Boolean(process.env.ENCRYPTION_KEY)
}

/** Mask a secret for display/logging, e.g. "12345…cdef". */
export function maskSecret(secret: string, visible = 4): string {
  if (secret.length <= visible * 2) return '••••'
  return `${secret.slice(0, visible)}…${secret.slice(-visible)}`
}
