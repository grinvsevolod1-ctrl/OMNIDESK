/**
 * Pure, dependency-free validation + parsing helpers for App Hosting inputs.
 * Kept separate from server actions so they can be unit-tested in isolation and
 * reused by the worker. No I/O, no secrets.
 */
import type { AppRuntime, ServerAuthType } from '../types'

export const APP_RUNTIMES: AppRuntime[] = ['node', 'docker', 'static', 'php']
export const SERVER_AUTH_TYPES: ServerAuthType[] = ['ssh_key', 'password']

/** True for a syntactically valid IPv4 address (0–255 per octet). */
export function isValidIpv4(value: string): boolean {
  const parts = value.trim().split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false
    const n = Number(p)
    return n >= 0 && n <= 255 && String(n) === p
  })
}

/**
 * Accept an IPv4 address OR a hostname (so operators can point at a DNS name).
 * Hostnames follow RFC-1123 label rules; total length capped at 253.
 */
export function isValidHost(value: string): boolean {
  const v = value.trim()
  if (!v || v.length > 253) return false
  if (isValidIpv4(v)) return true
  const label = /^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)$/
  return v.split('.').every((l) => label.test(l))
}

/** True for a TCP port in the valid 1–65535 range. */
export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/**
 * Validate a Git repository URL. Accepts https(s):// and scp-style
 * git@host:owner/repo(.git) forms, rejecting anything else (e.g. file://,
 * arbitrary shell) so nothing dangerous reaches the clone command.
 */
export function isValidRepoUrl(value: string): boolean {
  const v = value.trim()
  if (!v || v.length > 2048) return false
  // scp-like: git@github.com:owner/repo.git
  if (/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:[\w./~-]+$/.test(v)) return true
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'git:'
  } catch {
    return false
  }
}

/**
 * Validate a domain for the reverse proxy (bare hostname, no scheme/path).
 * Empty is allowed by callers who treat the domain as optional.
 */
export function isValidDomain(value: string): boolean {
  const v = value.trim()
  if (!v || v.length > 253) return false
  const label = /^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)$/
  const labels = v.split('.')
  if (labels.length < 2) return false
  return labels.every((l) => label.test(l))
}

/** True for an environment-variable name (POSIX-ish: letters, digits, underscore). */
export function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
}

/**
 * Parse a KEY=VALUE-per-line env block (dotenv-lite) into a validated map.
 * Blank lines and #comments are ignored. Surrounding quotes are stripped.
 * Returns an error message on the first malformed/duplicate/invalid key.
 */
export function parseEnvText(
  text: string,
): { ok: true; env: Record<string, string> } | { ok: false; error: string } {
  const env: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) {
      return { ok: false, error: `Строка без «=»: "${truncate(line)}"` }
    }
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (!isValidEnvKey(key)) {
      return { ok: false, error: `Недопустимое имя переменной: "${key}"` }
    }
    if (key in env) {
      return { ok: false, error: `Дублируется переменная: "${key}"` }
    }
    // Strip a single pair of matching surrounding quotes.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return { ok: true, env }
}

/** Serialize an env map back to a KEY=VALUE-per-line block for editing. */
export function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

function truncate(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
