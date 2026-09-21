// The document and its logic are packaged together. page3.markup.js carries
// the HTML as a string in the isolated world, so startup needs neither a
// network request nor a service-worker round trip. background.js is only
// needed for panel data; UI changes require downloading a new archive.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildZip, type ZipEntry } from './zip'

const TEMPLATES_DIR = join(process.cwd(), 'lib', 'god-ext', 'templates')

/** Static files copied verbatim into every generated extension. */
const STATIC_FILES = [
  'content.js',
  'background.js',
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
  /** The site's persistent API token; downloads do not rotate it. */
  token: string
  /** manifest name, e.g. "яндекс 11". */
  name: string
  /** manifest version, e.g. "1.0.3". */
  version: string
}

/** JSON serialization keeps credentials inert in the generated script. */
export function renderConfig(p: {
  apiBase: string
  page: string
  token: string
}): string {
  return `/* Автоматически сгенерировано god-панелью OMNIDESK.
   НЕ редактируйте вручную — перекачайте расширение из панели («Сайты»).

   Токен постоянный: все скачанные архивы этого сайта работают одновременно,
   пока в панели не нажата «Заменить токен». Разметка и логика вшиты в пакет:
   их обновление требует перекачки архива.
   Данные из панели продолжают обновляться обычным опросом. */
window.__CHARTER_CFG__ = {
  api: ${JSON.stringify(p.apiBase)},
  page: ${JSON.stringify(p.page)},
  token: ${JSON.stringify(p.token)},
  transport: 'poll',
  debug: false
};
`
}

export function renderMarkup(html: string): string {
  const literal = JSON.stringify(html)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `window.__CHARTER_HTML__ = ${literal};\n`
}

/** Permissions apply only to the panel and the two supported Direct hosts. */
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
    background: { service_worker: 'background.js' },
    content_scripts: [
      {
        matches: ['https://direct.yandex.ru/*', 'https://direct.yandex.com/*'],
        js: ['config.js', 'page3.markup.js', 'page3.app.js', 'content.js'],
        run_at: 'document_start',
      },
    ],
    permissions: ['declarativeNetRequestWithHostAccess'],
    host_permissions: [
      `${p.origin}/*`,
      'https://direct.yandex.ru/*',
      'https://direct.yandex.com/*',
    ],
    declarative_net_request: {
      rule_resources: [
        { id: 'ruleset_csp', enabled: true, path: 'rules.json' },
      ],
    },
  }
  return JSON.stringify(manifest, null, 2)
}

/** Builds the complete archive without network requests or token changes. */
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
  const markup = staticEntries.find((entry) => entry.name === 'page3.html')!

  const entries: ZipEntry[] = [
    {
      name: 'manifest.json',
      data: Buffer.from(
        renderManifest({ name: params.name, version: params.version, origin }),
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
    {
      name: 'page3.markup.js',
      data: Buffer.from(renderMarkup(markup.data.toString('utf8')), 'utf8'),
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
