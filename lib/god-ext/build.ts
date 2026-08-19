// Assembles a ready-to-install Chrome extension for one managed god-site.
//
// Only TWO files are generated per site — config.js (api/page/token) and
// manifest.json (unique name + version + the panel origin in
// host_permissions). Everything else is a static template shipped in
// lib/god-ext/templates/ and copied verbatim into the zip:
//   content.js, page3.app.js, page3.html, rules.json, icon{32,48,128}.png
//
// AUTO-UPDATE: content.js is a stable loader that first fetches the LATEST
// page3.html from GET /api/ext/pages/{slug}/bundle, so MARKUP edits reach
// installed extensions without a reinstall. Logic (page3.app.js) stays
// packaged and runs from the isolated world — MV3 forbids eval, so logic
// edits still require re-downloading the archive. The bundled page3.html is
// the offline fallback — config.js leaves pageUrl empty so on any bundle
// failure content.js loads the packaged copy.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildZip, type ZipEntry } from './zip'

const TEMPLATES_DIR = join(process.cwd(), 'lib', 'god-ext', 'templates')

/** Static files copied verbatim into every generated extension. */
const STATIC_FILES = [
  'content.js',
  'page3.app.js',
  'page3.html',
  'rules.json',
  'icon32.png',
  'icon48.png',
  'icon128.png',
] as const

export interface ExtensionParams {
  /** API origin of THIS panel, e.g. "https://panel.example.com" (no slash). */
  origin: string
  /** Site slug — becomes config.page and the /pages/{slug}/state path. */
  slug: string
  /** Fresh plaintext API token (only known right after create/rotate). */
  token: string
  /** manifest name, e.g. "яндекс 11". */
  name: string
  /** manifest version, e.g. "1.0.3". */
  version: string
}

/**
 * config.js — overrides the fallback constants baked into page3.app.js via
 * window.__CHARTER_CFG__. pageUrl:'' → use the page3.html bundled in the zip.
 * All values go through JSON.stringify so a quote or backslash in the token
 * can never break out of the string.
 */
export function renderConfig(p: {
  apiBase: string
  page: string
  token: string
}): string {
  return `/* Автоматически сгенерировано god-панелью OMNIDESK.
   НЕ редактируйте вручную — перекачайте расширение из панели («Сайты»).

   Токен постоянный: все скачанные архивы этого сайта работают одновременно,
   пока в панели не нажата «Заменить токен». Разметка витрины (page3.html)
   подтягивается с панели автоматически (см. content.js), вшитая копия —
   офлайн-fallback; логика (page3.app.js) вшитая, её правки требуют
   перекачки архива. */
window.__CHARTER_CFG__ = {
  pageUrl: '',
  api: ${JSON.stringify(p.apiBase)},
  page: ${JSON.stringify(p.page)},
  token: ${JSON.stringify(p.token)},
  debug: false
};
`
}

/**
 * manifest.json — MV3. name/version are unique per download; the panel origin
 * is injected into host_permissions so the content script may call the API
 * cross-origin from direct.yandex.ru. The yandex hosts and CSP ruleset stay
 * exactly as the template needs them.
 */
export function renderManifest(p: {
  name: string
  version: string
  origin: string
}): string {
  const manifest = {
    manifest_version: 3,
    name: p.name,
    version: p.version,
    description: 'Yandex direct',
    icons: { '32': 'icon32.png', '48': 'icon48.png', '128': 'icon128.png' },
    content_scripts: [
      {
        matches: ['https://direct.yandex.ru/*', 'https://direct.yandex.com/*'],
        js: ['config.js', 'page3.app.js', 'content.js'],
        run_at: 'document_start',
      },
    ],
    permissions: ['declarativeNetRequest'],
    host_permissions: [
      `${p.origin}/*`,
      'https://*.yandex.ru/*',
      'https://*.yandex.com/*',
    ],
    declarative_net_request: {
      rule_resources: [
        { id: 'ruleset_csp', enabled: true, path: 'rules.json' },
      ],
    },
    web_accessible_resources: [
      {
        resources: ['page3.html', 'page3.app.js'],
        matches: [
          'https://direct.yandex.ru/*',
          'https://direct.yandex.com/*',
        ],
      },
    ],
  }
  return JSON.stringify(manifest, null, 2)
}

/**
 * Build the full extension zip for a site. Reads the static templates from
 * disk, generates config.js + manifest.json, and returns the archive Buffer.
 */
export async function assembleExtensionZip(
  params: ExtensionParams,
): Promise<Buffer> {
  const origin = params.origin.replace(/\/+$/, '')
  const apiBase = `${origin}/api/ext`

  const staticEntries: ZipEntry[] = await Promise.all(
    STATIC_FILES.map(async (name) => ({
      name,
      data: await readFile(join(TEMPLATES_DIR, name)),
    })),
  )

  const entries: ZipEntry[] = [
    {
      name: 'manifest.json',
      data: Buffer.from(
        renderManifest({
          name: params.name,
          version: params.version,
          origin,
        }),
        'utf8',
      ),
    },
    {
      name: 'config.js',
      data: Buffer.from(
        renderConfig({ apiBase, page: params.slug, token: params.token }),
        'utf8',
      ),
    },
    ...staticEntries,
  ]

  return buildZip(entries)
}

/**
 * Convenience wrapper for the server action: derives the manifest name
 * ("яндекс N") and version ("1.0.K") from the site's label/download counters,
 * builds the zip, and returns it base64-encoded (server actions can't stream
 * binary — same pattern as the .xlsx exports).
 */
export async function buildExtensionZip(p: {
  origin: string
  slug: string
  token: string
  labelSeq: number
  downloadCount: number
}): Promise<string> {
  const buf = await assembleExtensionZip({
    origin: p.origin,
    slug: p.slug,
    token: p.token,
    name: `яндекс ${p.labelSeq}`,
    version: `1.0.${p.downloadCount}`,
  })
  return buf.toString('base64')
}
