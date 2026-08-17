import { NextResponse, type NextRequest } from 'next/server'
import { isAdminSessionCurrent } from './lib/admin-session'
import { getManagerAuthState } from './lib/data/managers'
import { SESSION_COOKIE, verifySession } from './lib/session'
import type { SessionUser } from './lib/types'

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
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    'report-uri /api/csp-report',
  ].join('; ')
}

async function sessionIsValid(session: SessionUser): Promise<boolean> {
  // Admin JWTs carry a credential-derived session version: rotating the admin
  // password / ADMIN_SESSION_NONCE revokes outstanding tokens right here.
  if (session.role === 'admin') return isAdminSessionCurrent(session.sv)
  if (
    session.role !== 'manager' &&
    session.role !== 'curator' &&
    session.role !== 'head'
  )
    return true
  try {
    const state = await getManagerAuthState(session.sub)
    if (!state) return false
    if (state.status === 'blocked') return false
    return (session.sv ?? 0) === state.sessionVersion
  } catch (error) {
    // FAIL-OPEN by design: a transient DB hiccup must not lock every
    // manager/curator out of the panel (page-level getSession still re-checks
    // and fails closed where it matters). The trade-off: while the DB is down,
    // a REVOKED-but-unexpired JWT passes this middleware check. Log every
    // occurrence so a burst of these lines in the logs is visible instead of
    // silent — if they correlate with a suspected token theft, restart the
    // panel after the DB recovers to force re-validation.
    console.error(
      '[proxy] session revocation check failed (DB error?) — failing OPEN for',
      `${session.role}:${session.sub}:`,
      error instanceof Error ? error.message : error,
    )
    return true
  }
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const rawSession = await verifySession(req.cookies.get(SESSION_COOKIE)?.value)
  const revoked = rawSession ? !(await sessionIsValid(rawSession)) : false
  const session = revoked ? null : rawSession

  const requestId = req.headers.get('x-request-id') || crypto.randomUUID()
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

  const homeFor = (role: string) => {
    if (role === 'admin') return '/admin'
    if (role === 'manager') return '/app'
    if (role === 'curator') return '/curator'
    if (role === 'head') return '/head'
    return '/login'
  }

  if (pathname === '/login') {
    if (session) return redirectTo(homeFor(session.role))
    return nextWithId()
  }

  if (pathname.startsWith('/admin')) {
    if (!session) return redirectTo('/login')
    if (session.role !== 'admin') return redirectTo(homeFor(session.role))
    return nextWithId()
  }

  if (pathname.startsWith('/app')) {
    if (!session) return redirectTo('/login')
    if (session.role !== 'manager') return redirectTo(homeFor(session.role))
    return nextWithId()
  }

  if (pathname.startsWith('/curator')) {
    if (!session) return redirectTo('/login')
    if (session.role !== 'curator') return redirectTo(homeFor(session.role))
    return nextWithId()
  }

  if (pathname.startsWith('/head')) {
    if (!session) return redirectTo('/login')
    if (session.role !== 'head') return redirectTo(homeFor(session.role))
    return nextWithId()
  }

  return nextWithId()
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.).*)'],
}
