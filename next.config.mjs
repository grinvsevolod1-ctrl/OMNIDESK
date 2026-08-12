import { execSync } from 'node:child_process'

/** @type {import('next').NextConfig} */

// Deterministic BUILD_ID = deployed git commit sha.
//
// WHY: without generateBuildId, `next build` invents a RANDOM id on every
// build. The update-watcher (components/update-watcher.tsx + /api/version)
// compares BUILD_IDs to decide "an update landed — show the overlay and
// reload". With random ids, ANY rebuild/redeploy of the SAME commit (an
// auto-deploy retry loop, a manual ./deploy.sh re-run, a pm2 recovery path)
// changed the id and flashed the "Устанавливается обновление" modal in every
// open tab even though nothing actually updated. Pinning the id to the commit
// sha means the overlay fires ONLY when a genuinely new commit from the
// deploy branch (main) goes live.
function gitCommitBuildId() {
  try {
    const sha = execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null
  } catch {
    // Not a git checkout (e.g. a tarball deploy) — null falls back to
    // Next's default random id.
    return null
  }
}

// Service workers must never be cached aggressively, or browsers keep serving
// an old (possibly broken) copy after a fix ships.
const noCache = { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }
// Widget loader: the script ships to every visitor of every customer site,
// often on slow mobile connections. `max-age=0, must-revalidate` made every
// page navigation pay a blocking revalidation round-trip before the widget
// could boot. Serve from cache instantly instead and refresh in the
// background: a fix still propagates within minutes (max-age) + one
// background revalidation — unlike a plain long max-age, which could pin a
// broken copy for a year.
const widgetCache = {
  key: 'Cache-Control',
  value: 'public, max-age=300, stale-while-revalidate=86400',
}
// The visitor service worker needs to control the whole origin (scope '/').
// This header authorises that broader scope.
const swAllowRoot = { key: 'Service-Worker-Allowed', value: '/' }

// Baseline security headers applied to every response (defence-in-depth for an
// authenticated ops panel). The enforcing Content-Security-Policy is NOT set
// here: it carries a per-request nonce and so is emitted from proxy.ts (the
// Node.js middleware) on every HTML route instead. Note the v0 chat preview
// strips framing/CSP headers, so these only fully apply on the deployed VPS
// (also fine to duplicate at nginx).
const securityHeaders = [
  // Stop MIME-sniffing responses into an unexpected content type.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Don't leak full URLs (which may carry ids) to third-party origins.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Clickjacking protection. The widget is injected as DOM on customer sites
  // (not an iframe of this origin), and the only in-app iframe is the
  // same-origin admin widget preview, so SAMEORIGIN is safe.
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  // Disable powerful browser features the panel never uses.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  // Force HTTPS for two years. Browsers ignore this over plain HTTP, so it is
  // harmless in local/dev. includeSubDomains is intentionally omitted in case a
  // subdomain is still served over HTTP.
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000',
  },
]

const nextConfig = {
  // Build output directory. Defaults to '.next', but deploy.sh overrides it via
  // NEXT_DIST_DIR to build into a throwaway folder and swap it in atomically,
  // so the currently-running server keeps serving the old build (no crash-loop
  // while '.next' would otherwise be missing mid-rebuild).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // See gitCommitBuildId() above: stable id per commit so the update overlay
  // only fires when the deployed code ACTUALLY changed.
  generateBuildId: gitCommitBuildId,
  // Do not advertise the framework in response headers (X-Powered-By: Next.js).
  poweredByHeader: false,
  // React Compiler (stable in Next 16, React 19.2). The codebase is written for
  // it — VirtualList is deliberately isolated so its non-memoizable TanStack
  // hook doesn't opt the giant realtime parents (InboxView, AI console) out of
  // compilation. Turning it on lets the compiler auto-memoize those components,
  // cutting wasted re-renders on every SSE tick / poll without hand-written
  // memo()/useMemo noise. Costs extra build time only; runtime is pure win.
  reactCompiler: true,
  experimental: {
    // recharts is a large barrel import (used by the analytics/finance charts)
    // and is NOT in Next's default optimizePackageImports list, so every chart
    // route pulled in far more of it than it used. This tree-shakes it to just
    // the pieces each file imports. lucide-react is optimized by default.
    optimizePackageImports: ['recharts'],
    serverActions: {
      // Chat media (video "кружочки", WhatsApp videos up to 16 MB, VK docs up to
      // 200 MB) is uploaded through Server Actions as multipart FormData. Next's
      // default request-body cap is only 1 MB, so any video was rejected by the
      // framework BEFORE the action ran — surfacing as the opaque "An unexpected
      // response was received from the server" error and crashing the inbox to
      // the error boundary. Raise the cap to comfortably cover the app's own
      // largest allowed upload (VK 200 MB) plus multipart/form-data overhead.
      bodySizeLimit: '210mb',
    },
  },
  images: {
    unoptimized: true,
  },
  async rewrites() {
    return [
      // Neutral, brand-free public name for the widget loader. The original
      // /livechat.js path keeps working for already-deployed snippets.
      { source: '/widget.js', destination: '/livechat.js' },
    ]
  },
  async headers() {
    return [
      {
        // Baseline security headers on every route.
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        source: '/livechat.js',
        headers: [widgetCache],
      },
      {
        // Neutral alias (rewritten to /livechat.js).
        source: '/widget.js',
        headers: [widgetCache],
      },
      {
        // Visitor service worker (Web Push + installability).
        source: '/widget-sw.js',
        headers: [noCache, swAllowRoot],
      },
    ]
  },
}

export default nextConfig
