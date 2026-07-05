/**
 * Panel-side login diagnostics (server actions). Mirrors the worker's auth
 * logging so a single connect attempt can be traced across both processes via
 * the shared channelId / attemptId.
 *
 * Toggle with existing config: AUTH_DEBUG=1 forces on, AUTH_DEBUG=0 forces off;
 * otherwise it is on outside production (safe mode). Phone numbers are always
 * masked — no full subscriber number is ever written to the logs.
 */

const FLAG = process.env.AUTH_DEBUG
export const authDebugEnabled =
  FLAG === '0'
    ? false
    : FLAG === '1' || (process.env.NODE_ENV ?? 'development') !== 'production'

/** Structured single-line log (JSON) matching the worker's pino output shape. */
export function authLog(event: string, data: Record<string, unknown>): void {
  if (!authDebugEnabled) return
  console.info(
    JSON.stringify({
      time: new Date().toISOString(),
      scope: 'tg-login',
      side: 'panel',
      event,
      ...data,
    }),
  )
}

/** Mask a phone for logging: keep country code + first digit and last two. */
export function maskPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 0) return '(empty)'
  if (digits.length < 5) return '*'.repeat(digits.length)
  const plus = raw.trim().startsWith('+') ? '+' : ''
  const head = digits.slice(0, 2)
  const tail = digits.slice(-2)
  return `${plus}${head}${'*'.repeat(digits.length - 4)}${tail}`
}

const KNOWN_PREFIXES: Array<{ code: string; region: string }> = [
  { code: '+7', region: 'RU/KZ' },
  { code: '+380', region: 'UA' },
  { code: '+375', region: 'BY' },
  { code: '+998', region: 'UZ' },
  { code: '+1', region: 'NANP (US/CA)' },
  { code: '+44', region: 'GB' },
  { code: '+49', region: 'DE' },
]

export interface PhoneShape {
  rawMasked: string
  e164Masked: string
  digitsLength: number
  hadPlus: boolean
  hadSpaces: boolean
  hadParens: boolean
  hadDashes: boolean
  region: string | null
  dialPrefix: string | null
  changedByNormalization: boolean
}

/** Privacy-safe description of a phone number for the logs (diagnostics only). */
export function describePhone(raw: string): PhoneShape {
  const trimmed = raw.trim()
  const digits = trimmed.replace(/\D/g, '')
  const e164 = '+' + digits
  let region: string | null = null
  let dialPrefix: string | null = null
  for (const p of KNOWN_PREFIXES) {
    if (e164.startsWith(p.code)) {
      region = p.region
      dialPrefix = p.code
      break
    }
  }
  return {
    rawMasked: maskPhone(raw),
    e164Masked: maskPhone(e164),
    digitsLength: digits.length,
    hadPlus: trimmed.startsWith('+'),
    hadSpaces: /\s/.test(trimmed),
    hadParens: /[()]/.test(trimmed),
    hadDashes: /-/.test(trimmed),
    region,
    dialPrefix,
    changedByNormalization: e164 !== trimmed,
  }
}
