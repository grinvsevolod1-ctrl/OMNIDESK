/**
 * Phone-number introspection for login diagnostics ONLY.
 *
 * Nothing here changes what is actually sent to Telegram — it exists purely so
 * the logs can answer "what shape was the number, what did we hand to MTProto,
 * and could formatting be the reason the code never arrives?" without leaking
 * the full subscriber number into the logs.
 */

/** Country dial-code prefixes we care about for diagnostics (RU/KZ first). */
const KNOWN_PREFIXES: Array<{ code: string; region: string }> = [
  { code: '+7', region: 'RU/KZ' },
  { code: '+380', region: 'UA' },
  { code: '+375', region: 'BY' },
  { code: '+998', region: 'UZ' },
  { code: '+1', region: 'NANP (US/CA)' },
  { code: '+44', region: 'GB' },
  { code: '+49', region: 'DE' },
]

/**
 * Mask a phone for logging: keep the country code + first digit and the last
 * two digits, replace the middle with asterisks. e.g. +7 999 123-45-67 -> +79****67
 */
export function maskPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 0) return '(empty)'
  if (digits.length < 5) return '*'.repeat(digits.length)
  const plus = raw.trim().startsWith('+') ? '+' : ''
  const head = digits.slice(0, 2)
  const tail = digits.slice(-2)
  const masked = '*'.repeat(digits.length - head.length - tail.length)
  return `${plus}${head}${masked}${tail}`
}

/**
 * Best-effort E.164 form used for comparison/diagnosis only (NOT for sending):
 * strip every non-digit and prepend "+". This mirrors what a correct
 * normaliser would produce so we can flag when the raw input differs.
 */
export function toE164(raw: string): string {
  return '+' + raw.replace(/\D/g, '')
}

export interface PhoneShape {
  /** Masked original input (as the user typed it). */
  rawMasked: string
  /** Masked best-effort E.164 form. */
  e164Masked: string
  /** Count of digits (no country/region info leaked). */
  digitsLength: number
  hadPlus: boolean
  hadSpaces: boolean
  hadParens: boolean
  hadDashes: boolean
  /** Detected region label for a known dial prefix, else null. */
  region: string | null
  /** Detected dial prefix (e.g. "+7"), else null. */
  dialPrefix: string | null
  /** True if trimming/normalisation would change the string (spaces, () , - …). */
  changedByNormalization: boolean
}

/** Produce a privacy-safe description of a phone number for the logs. */
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
