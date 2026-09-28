import { encryptionKeyBytes } from './crypto'
import { deriveGodKey, openWith, sealWith } from './god-envelope'

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

export function godSealNullable(value: string | null): string | null {
  return value === null ? null : godSeal(value)
}

export function godOpenNullable(value: string | null): string | null {
  return value === null ? null : godOpen(value)
}
