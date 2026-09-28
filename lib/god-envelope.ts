/**
 * Шифрование данных god-панели на уровне полей (AES-256-GCM).
 *
 * Чистый модуль без env и без БД: принимает мастер-ключ (32 байта из
 * ENCRYPTION_KEY) и выводит из него ОТДЕЛЬНЫЙ подключ через HKDF-SHA256 с
 * собственным `info`. Благодаря этому не нужен новый секрет на сервере
 * (деплой полностью автоматический), а шифротексты god-данных криптографически
 * отделены от остальных секретов проекта (`v1.`-конверты lib/crypto.ts).
 *
 * Используется и панелью (`lib/god-crypto.ts`), и воркером
 * (`worker/src/god-crypto.ts`) — формат обязан совпадать байт в байт.
 *
 * Формат: g1.<iv>.<tag>.<ciphertext> (каждая часть base64).
 * Значение БЕЗ префикса `g1.` считается легаси-открытым текстом и отдаётся как
 * есть: так чтение работает, пока бэкофилл (`lib/god-encrypt-backfill.ts`)
 * ещё не прошёл по старым строкам. Пустая строка не шифруется.
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto'

export const GOD_ENVELOPE_PREFIX = 'g1.'

const HKDF_SALT = Buffer.from('omnidesk/god-panel/salt/v1', 'utf8')
const HKDF_INFO = Buffer.from('omnidesk/god-panel/field-encryption/v1', 'utf8')

export function deriveGodKey(masterKey: Buffer): Buffer {
  if (masterKey.length !== 32) {
    throw new Error('Master key must be 32 bytes')
  }
  return Buffer.from(hkdfSync('sha256', masterKey, HKDF_SALT, HKDF_INFO, 32))
}

export function isGodSealed(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(GOD_ENVELOPE_PREFIX)
}

export function sealWith(key: Buffer, plaintext: string): string {
  if (plaintext === '' || isGodSealed(plaintext)) return plaintext
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return (
    GOD_ENVELOPE_PREFIX +
    [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.')
  )
}

export function openWith(key: Buffer, value: string): string {
  if (!isGodSealed(value)) return value
  const parts = value.slice(GOD_ENVELOPE_PREFIX.length).split('.')
  if (parts.length !== 3) throw new Error('Invalid god envelope')
  const [ivB64, tagB64, dataB64] = parts
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivB64, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}
