import 'server-only'

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Live vitrine bundle served to installed extensions so they self-update
 * WITHOUT a reinstall. The only file baked permanently into an installed
 * extension is the tiny loader (content.js); it fetches THIS bundle on every
 * page load and runs the latest markup + logic. So any edit to page3.html or
 * page3.app.js reaches every already-installed extension on its next open —
 * no re-download, no "Обновить" in the browser.
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
  /** page3.html markup (loader rewrites the tab DOM with it). */
  html: string
  /** page3.app.js logic (loader evals it → defines window.__CHARTER_INIT__). */
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
