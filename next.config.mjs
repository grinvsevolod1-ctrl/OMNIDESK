/** @type {import('next').NextConfig} */

// Widget loaders + service workers must never be cached aggressively, or
// browsers/CDNs keep serving an old (possibly broken) copy after a fix ships.
const noCache = { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }
// The visitor service worker needs to control the whole origin (scope '/').
// This header authorises that broader scope.
const swAllowRoot = { key: 'Service-Worker-Allowed', value: '/' }

// Content-Security-Policy in REPORT-ONLY mode. This blocks nothing — the
// browser only POSTs a violation report to /api/csp-report whenever a resource
// WOULD be blocked. Run it in report-only for a while, watch pm2 logs for real
// violations (especially unexpected connect-src / img-src origins), then:
//   1. tighten the directives to remove anything unused,
//   2. replace 'unsafe-inline' on script-src with a per-request nonce,
//   3. rename the header key to 'Content-Security-Policy' to ENFORCE it.
// 'unsafe-inline' is present now only because Next.js emits inline hydration
// scripts and the app uses inline styles; report-only means it protects nothing
// yet, so this is a staging step, not the final policy.
const cspReportOnly = [
  "default-src 'self'",
  // Next.js inline hydration + styled-jsx. Swap for a nonce before enforcing.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // Same-origin API routes + SSE realtime. Add external browser-called origins
  // here as report-only surfaces them.
  "connect-src 'self' https://ai-gateway.vercel.sh",
  "media-src 'self' blob: https:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  // The admin widget preview is a same-origin iframe; the customer-facing widget
  // is injected as DOM (not an iframe of this origin), so 'self' is safe.
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  'report-uri /api/csp-report',
].join('; ')

// Baseline security headers applied to every response (defence-in-depth for an
// authenticated ops panel). The enforcing set is conservative; the CSP above is
// report-only so it can't break the live panel or the embeddable widget while
// the team validates it. Note the v0 chat preview strips framing/CSP headers, so
// these only fully apply on the deployed VPS (also fine to duplicate at nginx).
const securityHeaders = [
  // CSP violation reporting (blocks nothing — see cspReportOnly above).
  { key: 'Content-Security-Policy-Report-Only', value: cspReportOnly },
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
  // Do not advertise the framework in response headers (X-Powered-By: Next.js).
  poweredByHeader: false,
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
        headers: [noCache],
      },
      {
        // Neutral alias (rewritten to /livechat.js).
        source: '/widget.js',
        headers: [noCache],
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
