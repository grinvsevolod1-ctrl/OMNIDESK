import 'server-only'
import { headers } from 'next/headers'

/**
 * Resolve the app's public base URL (scheme + host, no trailing slash) for use
 * in server actions / route handlers that need an absolute, externally
 * reachable URL — e.g. registering a MAX webhook with botapi.max.ru.
 *
 * Resolution order:
 *   1. APP_URL / NEXT_PUBLIC_APP_URL env var (explicit override — best for prod
 *      behind a custom domain or reverse proxy).
 *   2. VERCEL_URL (set automatically on Vercel deploys).
 *   3. The incoming request's forwarded host/proto headers.
 *
 * Throws when none of the above yields a usable absolute URL, so callers can
 * surface a clear error instead of silently registering a broken webhook.
 */
export async function resolveAppBaseUrl(): Promise<string> {
  const explicit = (
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    ''
  ).trim()
  if (explicit) return stripTrailingSlash(normalizeScheme(explicit))

  const vercel = (process.env.VERCEL_URL || '').trim()
  if (vercel) return stripTrailingSlash(normalizeScheme(vercel))

  // Fall back to the incoming request headers (set by the platform/proxy).
  const h = await headers()
  const host =
    h.get('x-forwarded-host')?.split(',')[0]?.trim() || h.get('host')?.trim()
  if (host) {
    const proto =
      h.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
      (host.startsWith('localhost') || host.startsWith('127.0.0.1')
        ? 'http'
        : 'https')
    return `${proto}://${host}`
  }

  throw new Error(
    'Не удалось определить публичный URL приложения. Задайте переменную окружения APP_URL.',
  )
}

/** Ensure a value like "example.com" or "https://example.com" has a scheme. */
function normalizeScheme(value: string): string {
  if (/^https?:\/\//i.test(value)) return value
  return `https://${value}`
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
