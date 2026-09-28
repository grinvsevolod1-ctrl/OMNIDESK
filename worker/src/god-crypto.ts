import { encryptionKeyBytes } from './crypto.js'
import { deriveGodKey, openWith, sealWith } from '../../lib/god-envelope.js'

let cachedKey: Buffer | null = null
function godKey(): Buffer {
  if (!cachedKey) cachedKey = deriveGodKey(encryptionKeyBytes())
  return cachedKey
}

export function godSeal(plaintext: string): string {
  return sealWith(godKey(), plaintext)
}

export function godOpen(value: string): string {
  return openWith(godKey(), value)
}

export function godOpenNullable(value: string | null): string | null {
  return value === null ? null : godOpen(value)
}
