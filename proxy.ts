import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySession } from './lib/session'

// Next.js 16 proxy (formerly middleware). Gates the panel routes by session
// role. The public live-chat API (/api/livechat/*) is intentionally NOT matched
// so website widgets can reach it cross-origin without a session.
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value)

  // Correlation id: reuse an incoming x-request-id (e.g. set by nginx) or mint
  // one. It's forwarded to the downstream handler (so server logs can tie lines
  // to a request) and echoed to the client for support/debugging. crypto is
  // available in the Edge runtime; we deliberately do NOT import the Node-only
  // request-context helper here.
  const requestId = req.headers.get('x-request-id') || crypto.randomUUID()
  const withRequestId = (res: NextResponse) => {
    res.headers.set('x-request-id', requestId)
    return res
  }
  const forwardHeaders = new Headers(req.headers)
  forwardHeaders.set('x-request-id', requestId)
  const nextWithId = () =>
    withRequestId(NextResponse.next({ request: { headers: forwardHeaders } }))

  const homeFor = (role: string) => (role === 'admin' ? '/admin' : '/app')

  // Already authenticated users should not see the login page.
  if (pathname === '/login') {
    if (session) {
      return withRequestId(
        NextResponse.redirect(new URL(homeFor(session.role), req.url)),
      )
    }
    return nextWithId()
  }

  // Admin area.
  if (pathname.startsWith('/admin')) {
    if (!session)
      return withRequestId(NextResponse.redirect(new URL('/login', req.url)))
    if (session.role !== 'admin')
      return withRequestId(NextResponse.redirect(new URL('/app', req.url)))
    return nextWithId()
  }

  // Manager area.
  if (pathname.startsWith('/app')) {
    if (!session)
      return withRequestId(NextResponse.redirect(new URL('/login', req.url)))
    if (session.role !== 'manager')
      return withRequestId(NextResponse.redirect(new URL('/admin', req.url)))
    return nextWithId()
  }

  return nextWithId()
}

export const config = {
  matcher: ['/login', '/admin/:path*', '/app/:path*'],
}
