/** @type {import('next').NextConfig} */

// Widget loaders + service workers must never be cached aggressively, or
// browsers/CDNs keep serving an old (possibly broken) copy after a fix ships.
const noCache = { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }
// The visitor service worker needs to control the whole origin (scope '/').
// This header authorises that broader scope.
const swAllowRoot = { key: 'Service-Worker-Allowed', value: '/' }

// Baseline security headers applied to every response (defence-in-depth for an
// authenticated ops panel). Deliberately conservative — no enforcing CSP here,
// because the app injects inline hydration scripts and the embeddable widget
// must keep working; tightening to a nonce-based CSP can come later. Note the
// v0 chat preview strips framing/CSP headers, so these only fully apply on the
// deployed VPS (also fine to duplicate at the nginx layer).
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
