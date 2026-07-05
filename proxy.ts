import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySession } from './lib/session'

// Next.js 16 proxy (formerly middleware). Gates the panel routes by session
// role. The public live-chat API (/api/livechat/*) is intentionally NOT matched
// so website widgets can reach it cross-origin without a session.
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value)

  const homeFor = (role: string) => (role === 'admin' ? '/admin' : '/app')

  // Already authenticated users should not see the login page.
  if (pathname === '/login') {
    if (session) {
      return NextResponse.redirect(new URL(homeFor(session.role), req.url))
    }
    return NextResponse.next()
  }

  // Admin area.
  if (pathname.startsWith('/admin')) {
    if (!session) return NextResponse.redirect(new URL('/login', req.url))
    if (session.role !== 'admin')
      return NextResponse.redirect(new URL('/app', req.url))
    return NextResponse.next()
  }

  // Manager area.
  if (pathname.startsWith('/app')) {
    if (!session) return NextResponse.redirect(new URL('/login', req.url))
    if (session.role !== 'manager')
      return NextResponse.redirect(new URL('/admin', req.url))
    return NextResponse.next()
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/login', '/admin/:path*', '/app/:path*'],
}
