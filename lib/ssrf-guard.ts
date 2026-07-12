import 'server-only'

/**
 * Lightweight SSRF guard for URLs we fetch server-side on behalf of a provider
 * (currently VK CDN attachment urls stored in media_ref, streamed via the
 * media proxy). These urls originate from provider API responses rather than
 * directly from an end user, so the risk is low — but we still refuse anything
 * that isn't a plain http(s) url pointing at a public host, so a compromised or
 * unexpected value can't be used to probe internal services (metadata
 * endpoints, localhost, the worker's private port, RFC1918 ranges, etc.).
 *
 * This is a best-effort literal-address check, NOT a full DNS-rebinding
 * defence: it blocks obvious private/loopback/link-local IP literals and
 * non-http(s) schemes. Hostnames that resolve to private IPs are not caught
 * here; that would require resolving + pinning the address at connect time.
 */

/** Returns true when an IPv4 literal falls in a private / reserved range. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((p) => Number(p))
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = octets
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 0) return true // 0.0.0.0/8
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local (metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  return false
}

/** Returns true when an IPv6 literal is loopback / link-local / unique-local. */
function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === '::1' || h === '::') return true // loopback / unspecified
  if (h.startsWith('fe80')) return true // link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true // unique-local fc00::/7
  // IPv4-mapped in dotted form (::ffff:127.0.0.1) — check the embedded v4 part.
  const dotted = h.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return isPrivateIpv4(dotted[1])
  // IPv4-mapped in hex form. The WHATWG URL parser normalises
  // `::ffff:127.0.0.1` to `::ffff:7f00:1`, so reconstruct the v4 octets from
  // the two trailing hextets and re-check.
  const hex = h.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
    return isPrivateIpv4(v4)
  }
  return false
}

/**
 * Validate that `rawUrl` is a safe public http(s) URL to fetch. Throws
 * `SsrfBlockedError` when it isn't.
 */
export class SsrfBlockedError extends Error {}

export function assertPublicHttpUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new SsrfBlockedError('invalid url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`blocked scheme: ${url.protocol}`)
  }
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new SsrfBlockedError('blocked host: localhost')
  }
  // IPv6 literal is wrapped in brackets in url.hostname? No — URL strips them
  // from hostname but keeps the colons, so detect by presence of ':'.
  if (host.includes(':')) {
    if (isPrivateIpv6(host)) throw new SsrfBlockedError('blocked private ipv6')
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isPrivateIpv4(host)) throw new SsrfBlockedError('blocked private ipv4')
  }
  return url
}
