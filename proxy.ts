import { NextResponse, type NextRequest } from 'next/server'
import { getManagerAuthState } from './lib/data/managers'
import { SESSION_COOKIE, verifySession } from './lib/session'
import type { SessionUser } from './lib/types'

// Next.js 16 proxy (formerly middleware). Runs on the Node.js runtime, so unlike
// the old Edge middleware it can reach Postgres directly. It:
//   1. gates panel routes by session role,
//   2. re-validates a manager's session against the live DB (block / password
//      change revocation), and
//   3. emits a per-request CSP nonce and an ENFORCING Content-Security-Policy.
// The public live-chat API (/api/livechat/*) is intentionally NOT matched so
// website widgets can reach it cross-origin without a session.

/**
 * Build the enforcing Content-Security-Policy for an HTML response, bound to a
 * per-request nonce. Next.js reads the nonce from the CSP we set on the request
 * headers and automatically applies it to the framework's own inline/hydration
 * scripts; `'strict-dynamic'` then lets those trusted scripts load the chunk
 * scripts they need, so no host allow-list is required for JS.
 *
 * `style-src 'unsafe-inline'` is retained because Next/React inject inline
 * styles (and there is no nonce hook for them); this is the standard, accepted
 * trade-off. `'unsafe-eval'` + `ws:` are added ONLY in development for the dev
 * server's HMR/react-refresh, never in production.
 */
function buildCsp(nonce: string): string {
  const dev = process.env.NODE_ENV !== 'production'
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    dev ? "'unsafe-eval'" : '',
  ]
    .filter(Boolean)
    .join(' ')
  const connectSrc = ["'self'", 'https://ai-gateway.vercel.sh', dev ? 'ws:' : '']
    .filter(Boolean)
    .join(' ')

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "media-src 'self' blob: https:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    // The admin widget preview is a same-origin iframe; the customer-facing
    // widget is injected as DOM (not an iframe of this origin), so 'self' is safe.
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    'report-uri /api/csp-report',
  ].join('; ')
}

/**
 * Re-validate an authenticated session against the live DB.
 *
 * Only managers are checked: the administrator is env-backed and has no row in
 * `managers`. A manager session is invalid when the account is gone, blocked, or
 * its session version was bumped (password change / forced logout). On a DB
 * hiccup we fail OPEN here — the redirect layer is UX only; the page-level
 * `requireManager` re-checks and is the real data boundary. (getManagerAuthState
 * caches for a few seconds, so this adds at most one tiny query per manager per
 * few seconds of navigation.)
 */
async function sessionIsValid(session: SessionUser): Promise<boolean> {
  if (session.role !== 'manager') return true
  try {
    const state = await getManagerAuthState(session.sub)
    if (!state) return false
    if (state.status === 'blocked') return false
    return (session.sv ?? 0) === state.sessionVersion
  } catch {
    return true
  }
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const rawSession = await verifySession(req.cookies.get(SESSION_COOKIE)?.value)
  // A signature-valid session that has since been revoked in the DB is treated
  // as no session at all (and its cookie is cleared on the way out).
  const revoked = rawSession ? !(await sessionIsValid(rawSession)) : false
  const session = revoked ? null : rawSession

  // Correlation id: reuse an incoming x-request-id (e.g. set by nginx) or mint
  // one. It's forwarded to the downstream handler (so server logs can tie lines
  // to a request) and echoed to the client for support/debugging.
  const requestId = req.headers.get('x-request-id') || crypto.randomUUID()

  // Per-request CSP nonce. Set on BOTH the forwarded request headers (so Next
  // applies it to its scripts and exposes it via headers() as x-nonce) and the
  // response headers (so the browser enforces the policy).
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const csp = buildCsp(nonce)

  const forwardHeaders = new Headers(req.headers)
  forwardHeaders.set('x-request-id', requestId)
  forwardHeaders.set('x-nonce', nonce)
  forwardHeaders.set('content-security-policy', csp)

  const decorate = (res: NextResponse) => {
    res.headers.set('x-request-id', requestId)
    res.headers.set('content-security-policy', csp)
    if (revoked) res.cookies.delete(SESSION_COOKIE)
    return res
  }
  const nextWithId = () =>
    decorate(NextResponse.next({ request: { headers: forwardHeaders } }))
  const redirectTo = (path: string) =>
    decorate(NextResponse.redirect(new URL(path, req.url)))

  const homeFor = (role: string) => (role === 'admin' ? '/admin' : '/app')

  // Already authenticated users should not see the login page.
  if (pathname === '/login') {
    if (session) return redirectTo(homeFor(session.role))
    return nextWithId()
  }

  // Admin area.
  if (pathname.startsWith('/admin')) {
    if (!session) return redirectTo('/login')
    if (session.role !== 'admin') return redirectTo('/app')
    return nextWithId()
  }

  // Manager area.
  if (pathname.startsWith('/app')) {
    if (!session) return redirectTo('/login')
    if (session.role !== 'manager') return redirectTo('/admin')
    return nextWithId()
  }

  return nextWithId()
}

export const config = {
  // Run on every HTML route (to attach the nonce'd CSP) but skip API routes,
  // Next internals and static assets (anything with a file extension). The
  // public live-chat API stays unmatched so cross-origin widgets keep working.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.).*)'],
}
