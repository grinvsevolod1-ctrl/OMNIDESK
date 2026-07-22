/** @type {import('next').NextConfig} */

// Widget loaders + service workers must never be cached aggressively, or
// browsers/CDNs keep serving an old (possibly broken) copy after a fix ships.
const noCache = { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }
// The visitor service worker needs to control the whole origin (scope '/').
// This header authorises that broader scope.
const swAllowRoot = { key: 'Service-Worker-Allowed', value: '/' }

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
