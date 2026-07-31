import type { VaultCategory, VaultField, VaultItem } from './finance-types'

/* ------------------------------------------------------------------ */
/* Password strength                                                   */
/* ------------------------------------------------------------------ */

export type StrengthLevel = 0 | 1 | 2 | 3 | 4

export interface PasswordStrength {
  /** 0 (empty) .. 4 (very strong) */
  score: StrengthLevel
  label: string
  /** Tailwind text/bg tone token suffix used by the meter. */
  tone: 'muted' | 'destructive' | 'warning' | 'success'
  /** Percentage width for the meter bar. */
  percent: number
}

/**
 * Lightweight, dependency-free password strength estimate.
 * Not a substitute for zxcvbn, but good enough to nudge users away
 * from weak/short secrets. Returns a 0..4 score.
 */
export function scorePassword(password: string): PasswordStrength {
  if (!password) {
    return { score: 0, label: 'Нет пароля', tone: 'muted', percent: 0 }
  }

  let score = 0
  const len = password.length

  // Length is the dominant factor.
  if (len >= 8) score += 1
  if (len >= 12) score += 1
  if (len >= 16) score += 1

  // Character variety.
  const classes =
    Number(/[a-z]/.test(password)) +
    Number(/[A-Z]/.test(password)) +
    Number(/[0-9]/.test(password)) +
    Number(/[^A-Za-z0-9]/.test(password))
  if (classes >= 3) score += 1
  if (classes >= 4 && len >= 12) score += 1

  // Penalties for obvious weakness.
  if (/^[a-z]+$/i.test(password) || /^\d+$/.test(password)) score -= 1
  if (/(.)\1{2,}/.test(password)) score -= 1 // repeated chars aaaa
  if (/^(1234|123456|qwerty|password|admin|000000)/i.test(password)) {
    score = 0
  }

  const clamped = Math.max(0, Math.min(4, score)) as StrengthLevel

  const META: Record<
    StrengthLevel,
    { label: string; tone: PasswordStrength['tone'] }
  > = {
    0: { label: 'Очень слабый', tone: 'destructive' },
    1: { label: 'Слабый', tone: 'destructive' },
    2: { label: 'Средний', tone: 'warning' },
    3: { label: 'Хороший', tone: 'success' },
    4: { label: 'Надёжный', tone: 'success' },
  }

  return {
    score: clamped,
    label: META[clamped].label,
    tone: password ? META[clamped].tone : 'muted',
    percent: password ? Math.max(12, (clamped / 4) * 100) : 0,
  }
}

/* ------------------------------------------------------------------ */
/* Reused-password detection                                           */
/* ------------------------------------------------------------------ */

/** Set of secrets that appear on more than one item (case-sensitive). */
export function findReusedSecrets(items: VaultItem[]): Set<string> {
  const counts = new Map<string, number>()
  for (const it of items) {
    if (!it.secret) continue
    counts.set(it.secret, (counts.get(it.secret) ?? 0) + 1)
  }
  const reused = new Set<string>()
  for (const [secret, n] of counts) if (n > 1) reused.add(secret)
  return reused
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export interface VaultExportRow {
  category: VaultCategory
  title: string
  login: string
  secret: string
  url: string
  fields: VaultField[]
  note: string
  tags: string[]
  favorite: boolean
}

export function itemsToExport(items: VaultItem[]): VaultExportRow[] {
  return items.map((it) => ({
    category: it.category,
    title: it.title,
    login: it.login,
    secret: it.secret,
    url: it.url,
    fields: it.fields,
    note: it.note,
    tags: it.tags,
    favorite: it.favorite,
  }))
}

export function toJSON(items: VaultItem[]): string {
  return JSON.stringify(
    { version: 1, exportedAt: new Date().toISOString(), items: itemsToExport(items) },
    null,
    2,
  )
}

function csvCell(value: string): string {
  const v = value ?? ''
  if (/[",\n;]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}

export function toCSV(items: VaultItem[]): string {
  const header = [
    'category',
    'title',
    'login',
    'secret',
    'url',
    'note',
    'tags',
    'favorite',
    'fields',
  ]
  const rows = items.map((it) =>
    [
      it.category,
      it.title,
      it.login,
      it.secret,
      it.url,
      it.note,
      it.tags.join('|'),
      it.favorite ? 'yes' : 'no',
      it.fields.map((f) => `${f.label}=${f.value}${f.secret ? '*' : ''}`).join('|'),
    ]
      .map((c) => csvCell(String(c)))
      .join(','),
  )
  return [header.join(','), ...rows].join('\n')
}

/** Trigger a browser download of a text file. */
export function downloadText(
  filename: string,
  content: string,
  mime = 'text/plain',
): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

export interface ParsedVaultRow {
  category: string
  title: string
  login: string
  secret: string
  url: string
  note: string
  tags: string[]
  favorite: boolean
  fields: VaultField[]
}

function parseFieldsString(raw: string): VaultField[] {
  if (!raw) return []
  return raw
    .split('|')
    .map((chunk) => {
      const secret = chunk.endsWith('*')
      const body = secret ? chunk.slice(0, -1) : chunk
      const eq = body.indexOf('=')
      if (eq === -1) return null
      return {
        label: body.slice(0, eq).trim(),
        value: body.slice(eq + 1),
        secret,
      }
    })
    .filter((f): f is VaultField => f != null && (!!f.label || !!f.value))
}

/** Parse a JSON export back into importable rows. */
export function parseJSONImport(text: string): ParsedVaultRow[] {
  const data = JSON.parse(text)
  const list = Array.isArray(data) ? data : data?.items
  if (!Array.isArray(list)) throw new Error('Неверный формат JSON')
  return list.map((raw) => ({
    category: String(raw.category ?? 'other'),
    title: String(raw.title ?? '').trim(),
    login: String(raw.login ?? ''),
    secret: String(raw.secret ?? ''),
    url: String(raw.url ?? ''),
    note: String(raw.note ?? ''),
    tags: Array.isArray(raw.tags)
      ? raw.tags.map(String)
      : String(raw.tags ?? '')
          .split(/[|,]/)
          .map((t: string) => t.trim())
          .filter(Boolean),
    favorite: raw.favorite === true || raw.favorite === 'yes',
    fields: Array.isArray(raw.fields)
      ? raw.fields
          .filter((f: unknown) => f && typeof f === 'object')
          .map((f: Record<string, unknown>) => ({
            label: String(f.label ?? ''),
            value: String(f.value ?? ''),
            secret: Boolean(f.secret),
          }))
      : typeof raw.fields === 'string'
        ? parseFieldsString(raw.fields)
        : [],
  }))
}

/** Minimal CSV line splitter that respects quoted cells. */
function splitCSVLine(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQuotes = false
      } else cur += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      cells.push(cur)
      cur = ''
    } else cur += ch
  }
  cells.push(cur)
  return cells
}

/** Parse a CSV export back into importable rows. */
export function parseCSVImport(text: string): ParsedVaultRow[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim())
  if (lines.length < 2) return []
  const header = splitCSVLine(lines[0]).map((h) => h.trim().toLowerCase())
  const idx = (name: string) => header.indexOf(name)
  const rows: ParsedVaultRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const c = splitCSVLine(lines[i])
    const get = (name: string) => {
      const j = idx(name)
      return j >= 0 ? (c[j] ?? '') : ''
    }
    const title = get('title').trim()
    if (!title) continue
    rows.push({
      category: get('category') || 'other',
      title,
      login: get('login'),
      secret: get('secret'),
      url: get('url'),
      note: get('note'),
      tags: get('tags').split('|').map((t) => t.trim()).filter(Boolean),
      favorite: /^(yes|true|1)$/i.test(get('favorite')),
      fields: parseFieldsString(get('fields')),
    })
  }
  return rows
}

/** Detect format from filename/content and parse. */
export function parseVaultFile(filename: string, text: string): ParsedVaultRow[] {
  const isJSON =
    filename.toLowerCase().endsWith('.json') || text.trim().startsWith('{') || text.trim().startsWith('[')
  return isJSON ? parseJSONImport(text) : parseCSVImport(text)
}
