import 'server-only'

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Live vitrine bundle served to installed extensions so their MARKUP
 * self-updates WITHOUT a reinstall. The only file baked permanently into an
 * installed extension is the tiny loader (content.js); it fetches THIS bundle
 * on every page load and renders the latest page3.html. So any edit to
 * page3.html reaches every already-installed extension on its next open — no
 * re-download.
 *
 * LOGIC IS NOT LIVE-UPDATED: Manifest V3 unconditionally forbids eval/new
 * Function in a content script's isolated world (the extension's own CSP —
 * page-CSP removal via rules.json does not help, and 'unsafe-eval' is banned
 * for MV3 content scripts). So `app` CANNOT be executed from a string; the
 * loader ignores it and runs the packaged page3.app.js instead. We still ship
 * `app` here for backward compatibility with older installed loaders (they
 * eval it, it's blocked, and they gracefully fall back) and so `version`
 * flips whenever the logic changes too.
 *
 * `version` is a content hash: it changes iff the templates change, letting
 * the client (and tests) detect an update deterministically. The bundle is
 * read once and cached for the process lifetime — templates only change on
 * deploy, and a deploy starts a fresh process, so the cache is always fresh.
 */

const TEMPLATES_DIR = join(process.cwd(), 'lib', 'god-ext', 'templates')

export interface VitrineBundle {
  /** Short sha256 over html+app — stable across reads, changes on edit. */
  version: string
  /** page3.html markup (loader rewrites the tab DOM with it — live-updated). */
  html: string
  /**
   * page3.app.js logic — shipped for backward compat + version hashing only.
   * The current loader does NOT execute it (MV3 blocks eval); it runs the
   * packaged page3.app.js. Logic changes require re-downloading the archive.
   */
  app: string
}

let cache: VitrineBundle | null = null

export async function getVitrineBundle(): Promise<VitrineBundle> {
  if (cache) return cache
  const [html, app] = await Promise.all([
    readFile(join(TEMPLATES_DIR, 'page3.html'), 'utf8'),
    readFile(join(TEMPLATES_DIR, 'page3.app.js'), 'utf8'),
  ])
  // NUL separator so concatenation can't alias a different html/app split.
  const version = createHash('sha256')
    .update(html)
    .update('\0')
    .update(app)
    .digest('hex')
    .slice(0, 16)
  cache = { version, html, app }
  return cache
}
