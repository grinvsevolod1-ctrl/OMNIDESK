/**
 * Eager media archiving for the serverless webhook channels (VK / WhatsApp).
 *
 * The panel runs as a long-lived Node process (pm2 / `next start`), so a
 * fire-and-forget promise kicked off from a webhook handler runs to completion
 * even after we've acked the provider. That lets us pull a freshly received
 * photo / video / voice note and copy its bytes into Postgres immediately —
 * before the contact has any chance to delete or edit it — without blocking the
 * webhook ack.
 *
 * All functions are best-effort and never throw: archiving failures are logged
 * and swallowed, and the media proxy still lazily archives on first view as a
 * safety net.
 */

import {
  messageNeedsMediaBytes,
  storeMessageMediaBytes,
  MEDIA_MAX_STORE_BYTES,
  MEDIA_ARCHIVE_ENABLED,
} from '@/lib/data'
import { proxiedFetch, type ProxyDescriptor } from '@/lib/proxy-agent'
import { assertPublicHttpUrl } from '@/lib/ssrf-guard'
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp-cloud'

/** Read a fetch Response into a Buffer, bailing if it exceeds the size cap. */
async function readCapped(res: Response): Promise<Buffer | null> {
  const len = Number(res.headers.get('content-length') || 0)
  if (len && len > MEDIA_MAX_STORE_BYTES) return null
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength === 0 || buf.byteLength > MEDIA_MAX_STORE_BYTES) return null
  return buf
}

/**
 * Archive a VK attachment (direct CDN url) into Postgres. Streams through the
 * account's proxy so VK only ever sees the dedicated IP. Fire-and-forget.
 */
export async function archiveVkMediaSoon(args: {
  messageId: string
  url: string
  proxy: ProxyDescriptor | null
  mime: string | null
  name: string | null
}): Promise<void> {
  if (!MEDIA_ARCHIVE_ENABLED) return
  try {
    if (!(await messageNeedsMediaBytes(args.messageId))) return
    assertPublicHttpUrl(args.url)
    const res = await proxiedFetch(args.url, { cache: 'no-store' }, args.proxy)
    if (!res.ok) return
    const buf = await readCapped(res)
    if (!buf) return
    const mime = res.headers.get('content-type') || args.mime
    await storeMessageMediaBytes(args.messageId, buf, mime, args.name)
  } catch (err) {
    console.error('[media-archive] vk archive failed:', err)
  }
}

/**
 * Archive a WhatsApp Cloud media object into Postgres. Resolves the temporary
 * Graph media url, downloads the bytes with the app token, stores them.
 * Fire-and-forget.
 */
export async function archiveWhatsappMediaSoon(args: {
  messageId: string
  waMediaId: string
  token: string
  mime: string | null
  name: string | null
}): Promise<void> {
  if (!MEDIA_ARCHIVE_ENABLED) return
  try {
    if (!(await messageNeedsMediaBytes(args.messageId))) return
    const info = await getMediaUrl(args.waMediaId, args.token)
    if (!info.ok) return
    const res = await downloadMedia(info.data.url, args.token)
    if (!res || !res.ok) return
    const buf = await readCapped(res)
    if (!buf) return
    const mime = res.headers.get('content-type') || info.data.mime_type || args.mime
    await storeMessageMediaBytes(args.messageId, buf, mime, args.name)
  } catch (err) {
    console.error('[media-archive] whatsapp archive failed:', err)
  }
}
