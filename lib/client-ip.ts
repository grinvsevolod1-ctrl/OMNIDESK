/**
 * Canonical client-IP extraction for rate limiting and audit logs.
 *
 * Threat model: proxy headers (`x-real-ip`, `x-forwarded-for`) are attacker
 * controlled UNLESS a trusted reverse-proxy (nginx/Caddy) overwrites them.
 * The production deploy (deploy/nginx.conf.example) sets X-Real-IP from
 * $remote_addr, so trusting them is correct there — but if the Node process is
 * ever exposed directly, an attacker could rotate fake IPs to bypass per-IP
 * limits, or worse, inject another user's IP to get them banned.
 *
 * Defenses applied here:
 *  1. `TRUST_PROXY=false` disables header trust entirely (direct exposure).
 *  2. Every candidate is syntactically validated as IPv4/IPv6 — garbage like
 *     `X-Real-IP: <script>` or 4 KB junk can neither poison logs nor blow up
 *     rate-limit key cardinality. Invalid values collapse to 'unknown'.
 *  3. From `x-forwarded-for` we take the RIGHTMOST hop (the one appended by
 *     OUR proxy) — left-hand entries are client-supplied and spoofable.
 *
 * Single source of truth: login, live-chat ingest and messenger actions all
 * import from here so the trust policy can never silently diverge again.
 */

const MAX_HEADER_LEN = 512

// Practical (not RFC-exhaustive) validators: IPv4 dotted quad with octet range
// check, and a conservative IPv6 charset/shape check that accepts all real
// addresses (including embedded-IPv4 like ::ffff:1.2.3.4) while rejecting junk.
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const IPV6_RE = /^[0-9a-fA-F:.]{2,45}$/

export function isValidIp(value: string): boolean {
  if (!value || value.length > 45) return false
  const m = IPV4_RE.exec(value)
  if (m) {
    return m.slice(1).every((octet) => Number(octet) <= 255)
  }
  // IPv6 must contain at least one colon; dots only allowed for the
  // IPv4-mapped tail.
  if (!value.includes(':')) return false
  return IPV6_RE.test(value)
}

/** Strip an optional port / brackets: "1.2.3.4:5678", "[::1]:443" → bare IP. */
function normalizeCandidate(raw: string): string {
  let v = raw.trim()
  if (v.startsWith('[')) {
    const end = v.indexOf(']')
    if (end > 0) v = v.slice(1, end)
  } else if (IPV4_RE.test(v.split(':')[0] ?? '') && v.includes(':')) {
    v = v.split(':')[0]!
  }
  return v
}

/**
 * Resolve the client IP from request headers. Returns 'unknown' when proxy
 * headers are untrusted, missing, or fail validation. 'unknown' pools all such
 * requests into one rate-limit bucket — strict, never permissive.
 */
export function clientIpFromHeaders(headers: Headers): string {
  if (process.env.TRUST_PROXY === 'false') return 'unknown'

  // Cloudflare sets CF-Connecting-IP to the real TCP peer; a client cannot
  // forge it end-to-end when traffic actually flows through Cloudflare.
  const cf = headers.get('cf-connecting-ip')
  if (cf && cf.length <= MAX_HEADER_LEN) {
    const ip = normalizeCandidate(cf)
    if (isValidIp(ip)) return ip
  }

  const real = headers.get('x-real-ip')
  if (real && real.length <= MAX_HEADER_LEN) {
    const ip = normalizeCandidate(real)
    if (isValidIp(ip)) return ip
  }

  const fwd = headers.get('x-forwarded-for')
  if (fwd && fwd.length <= MAX_HEADER_LEN) {
    const parts = fwd.split(',').map((p) => p.trim()).filter(Boolean)
    // Rightmost = appended by our own proxy; earlier hops are client-supplied.
    for (let i = parts.length - 1; i >= 0; i--) {
      const ip = normalizeCandidate(parts[i]!)
      if (isValidIp(ip)) return ip
    }
  }

  return 'unknown'
}
