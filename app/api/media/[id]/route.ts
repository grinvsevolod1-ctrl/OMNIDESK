import { getSession } from '@/lib/auth'
import {
  getMessageOwner,
  getStoredEditMediaBytes,
  getStoredMediaBytes,
  getUrlMediaDescriptor,
  getWhatsappMediaDescriptor,
  MEDIA_MAX_STORE_BYTES,
  storeMessageMediaBytes,
} from '@/lib/data'
import { proxiedFetch } from '@/lib/proxy-agent'
import { assertPublicHttpUrl } from '@/lib/ssrf-guard'
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp-cloud'
import { isWorkerConfigured, streamFromWorker } from '@/lib/worker-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Stream a message's media to the browser.
 *
 * The browser can't reach the worker directly (it listens on 127.0.0.1 behind a
 * shared secret), so this route: (1) checks the signed-in manager actually owns
 * the message, then (2) asks the worker to re-download the bytes from the
 * provider and pipes the response straight through. Nothing binary is stored.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession()
  if (!session) return new Response('Unauthorized', { status: 401 })

  const { id } = await params
  if (!id) return new Response('Bad request', { status: 400 })

  // Ownership check: the message must belong to a conversation this manager owns.
  const owner = await getMessageOwner(id, session.sub)
  if (!owner) return new Response('Not found', { status: 404 })

  // Historical (pre-edit) version of the media, addressed by edit id. Ownership
  // is already established via the message id above.
  const editId = new URL(request.url).searchParams.get('edit')
  if (editId) {
    const hist = await getStoredEditMediaBytes(editId)
    if (!hist) return new Response('Media unavailable', { status: 410 })
    return bytesResponse(hist.bytes, hist.mime, true)
  }

  // Durable fast path: if we archived the bytes in Postgres at ingest (so the
  // file survives the contact deleting/editing it), serve them straight from the
  // database — no provider round-trip, and it works even after remote deletion.
  const stored = await getStoredMediaBytes(id)
  if (stored) {
    return bytesResponse(stored.bytes, stored.mime, true)
  }

  // WhatsApp Cloud has no worker: the panel resolves the media id and downloads
  // the bytes straight from the Graph API with the app access token, then pipes
  // them through. (Telegram/MAX media still go via the worker below.)
  if (owner.channelType === 'whatsapp') {
    const desc = await getWhatsappMediaDescriptor(id)
    if (!desc) return new Response('Media unavailable', { status: 404 })
    const info = await getMediaUrl(desc.waMediaId, desc.token)
    if (!info.ok) {
      return new Response('Media unavailable', { status: info.status || 502 })
    }
    const upstream = await downloadMedia(info.data.url, desc.token)
    if (!upstream || !upstream.ok || !upstream.body) {
      return new Response('Media unavailable', {
        status: upstream?.status || 502,
      })
    }
    const mime =
      upstream.headers.get('content-type') ||
      info.data.mime_type ||
      desc.mime ||
      'application/octet-stream'
    // Buffer + archive so the file survives the contact deleting it later, then
    // serve from the buffer. Falls back to a passthrough stream on any issue.
    const buffered = await bufferAndArchive(id, upstream, mime, null)
    if (buffered) return bytesResponse(buffered, mime, false)
    return passthrough(upstream, mime)
  }

  // VK (like MAX/live-chat) has no worker: attachments carry a direct CDN url
  // stored in media_ref. We stream those bytes through the account's proxy so
  // the manager's browser never hits VK directly (consistent IP, no hotlink/CORS
  // issues) and the raw url is never exposed to the client.
  if (owner.channelType === 'vk') {
    const desc = await getUrlMediaDescriptor(id)
    if (!desc) return new Response('Media unavailable', { status: 404 })
    // Defence-in-depth: the url comes from VK API responses (not the user), but
    // refuse to fetch anything that isn't a public http(s) address so a stray
    // value can't be used to probe internal services (loopback, worker port,
    // RFC1918, cloud metadata, non-http schemes).
    try {
      assertPublicHttpUrl(desc.url)
    } catch {
      return new Response('Media unavailable', { status: 400 })
    }
    let upstream: Response
    try {
      upstream = await proxiedFetch(
        desc.url,
        { cache: 'no-store' },
        desc.proxy,
      )
    } catch {
      return new Response('Media unavailable', { status: 502 })
    }
    if (!upstream.ok || !upstream.body) {
      return new Response('Media unavailable', { status: upstream.status || 502 })
    }
    const mime =
      upstream.headers.get('content-type') ||
      desc.mime ||
      'application/octet-stream'
    // Buffer + archive so the file survives the contact deleting it later.
    const buffered = await bufferAndArchive(id, upstream, mime, null)
    if (buffered) return bytesResponse(buffered, mime, false)
    return passthrough(upstream, mime)
  }

  if (!isWorkerConfigured) {
    return new Response('Worker not configured', { status: 503 })
  }

  const upstream = await streamFromWorker(
    `/media?messageId=${encodeURIComponent(id)}`,
  )
  if (!upstream) {
    return new Response('Media unavailable', { status: 502 })
  }
  if (!upstream.ok || !upstream.body) {
    return new Response('Media unavailable', { status: upstream.status || 502 })
  }

  const headers = new Headers()
  for (const h of ['content-type', 'content-length', 'content-disposition']) {
    const v = upstream.headers.get(h)
    if (v) headers.set(h, v)
  }
  headers.set('cache-control', 'private, max-age=86400')

  return new Response(upstream.body, { status: 200, headers })
}

/** Serve a buffer we already hold in memory. `immutable` when it came from the
 *  durable archive (content can never change), otherwise a normal day cache. */
function bytesResponse(
  bytes: Buffer,
  mime: string | null,
  immutable: boolean,
): Response {
  const headers = new Headers()
  headers.set('content-type', mime || 'application/octet-stream')
  headers.set('content-length', String(bytes.byteLength))
  headers.set(
    'cache-control',
    immutable
      ? 'private, max-age=31536000, immutable'
      : 'private, max-age=86400',
  )
  return new Response(new Uint8Array(bytes), { status: 200, headers })
}

/** Stream an upstream response straight through (fallback when not buffering). */
function passthrough(upstream: Response, mime: string): Response {
  const headers = new Headers()
  headers.set('content-type', mime)
  const len = upstream.headers.get('content-length')
  if (len) headers.set('content-length', len)
  headers.set('cache-control', 'private, max-age=86400')
  return new Response(upstream.body, { status: 200, headers })
}

/**
 * Read an upstream media response fully into memory and archive it in Postgres
 * (idempotent, size-capped) so the file survives the contact deleting/editing
 * it. Returns the buffer on success, or null when the body is missing or too
 * large (caller then streams it through without archiving). Never throws.
 */
async function bufferAndArchive(
  messageId: string,
  upstream: Response,
  mime: string | null,
  name: string | null,
): Promise<Buffer | null> {
  // Size guard: storeMessageMediaBytes rejects anything over MEDIA_MAX_STORE_BYTES
  // anyway, and providers allow very large files (Telegram up to ~2GB). Reading
  // the whole body into memory unconditionally could OOM the panel process, so
  // when the upstream advertises a content-length above the cap we DON'T buffer —
  // the caller then streams the bytes straight through without archiving.
  const declaredLen = Number(upstream.headers.get('content-length'))
  if (Number.isFinite(declaredLen) && declaredLen > MEDIA_MAX_STORE_BYTES) {
    return null
  }
  try {
    const ab = await upstream.arrayBuffer()
    const buf = Buffer.from(ab)
    if (buf.byteLength === 0) return null
    // Only archive when within the cap. If the real size turns out larger (no
    // content-length was declared up front), we still serve the buffer we've
    // already read — we can't re-stream a consumed body — but skip the DB write.
    if (buf.byteLength <= MEDIA_MAX_STORE_BYTES) {
      // Fire-and-forget archive; serving the bytes must not wait on the write.
      void storeMessageMediaBytes(messageId, buf, mime, name).catch(() => {})
    }
    return buf
  } catch {
    return null
  }
}
