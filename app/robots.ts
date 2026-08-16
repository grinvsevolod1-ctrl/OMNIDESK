import type { MetadataRoute } from 'next'

/**
 * Robots policy for the panel.
 *
 * Omnidesk is a private, self-hosted operations panel — none of it is meant to
 * be crawled or indexed, so we disallow everything with a single blanket rule.
 *
 * IMPORTANT: we deliberately do NOT list the god-mode console path here. A
 * `Disallow: /wijegniwjgwjog` line would publish the secret route to anyone who
 * opens /robots.txt. A blanket `Disallow: /` hides it just as well without
 * revealing it, and site-wide `noindex` (see app/layout.tsx metadata) is the
 * real enforcement for crawlers that ignore robots rules.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', disallow: '/' }],
  }
}
