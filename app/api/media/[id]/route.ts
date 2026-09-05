import { getSession } from '@/lib/auth'
import { isMessengerUnlocked } from '@/lib/messenger-gate'
import { isGodUnlocked } from '@/lib/god-gate'
import {
  getMessageOwner,
  getMessageOwnerAdmin,
  getMessageOwnerForCurator,
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
  // The god messenger / god console are admin-wide surfaces: they may stream
  // ANY message's media once their own gate cookie is verified. A manager
  // session is scoped to conversations that manager owns.
  const adminWide =
    !session && ((await isMessengerUnlocked()) || (await isGodUnlocked()))
  if (!session && !adminWide) return new Response('Unauthorized', { status: 401 })

  const { id } = await params
  if (!id) return new Response('Bad request', { status: 400 })

  // Ownership check: the message must belong to a conversation this manager
  // owns, or — for a curator session — a conversation transferred to THEM
  // (recordTransfer sets curator_id; see getMessageOwnerForCurator), or exist
  // at all for the admin-wide surfaces.
  const owner = session
    ? session.role === 'curator'
      ? await getMessageOwnerForCurator(id, session.sub)
      : await getMessageOwner(id, session.sub)
    : await getMessageOwnerAdmin(id)
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
    // Stream to the browser while archiving a bounded copy in the background so
    // the file survives the contact deleting it later (never buffers an oversized
    // file into memory — see serveAndArchive).
    return serveAndArchive(id, upstream, mime, null)
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
    // Stream to the browser while archiving a bounded copy in the background so
    // the file survives the contact deleting it later.
    return serveAndArchive(id, upstream, mime, null)
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

/**
 * Stream an upstream media response straight to the browser while archiving a
 * SIZE-BOUNDED copy in Postgres in the background, so the file survives the
 * contact deleting/editing it.
 *
 * The body is `tee()`d into two independent streams: one is returned to the
 * client untouched, the other is read by `archiveBounded` which stops (and
 * skips the DB write) the moment it exceeds MEDIA_MAX_STORE_BYTES. This never
 * reads a whole file into memory — the previous `arrayBuffer()` approach could
 * OOM the panel when a provider omitted content-length on a multi-hundred-MB /
 * multi-GB file (Telegram allows ~2GB). Serving is never blocked on the write.
 */
function serveAndArchive(
  messageId: string,
  upstream: Response,
  mime: string,
  name: string | null,
): Response {
  const body = upstream.body
  if (!body) return new Response('Media unavailable', { status: 502 })

  const headers = new Headers()
  headers.set('content-type', mime)
  const declaredLen = Number(upstream.headers.get('content-length'))
  const hasLen = Number.isFinite(declaredLen) && declaredLen > 0
  if (hasLen) headers.set('content-length', String(declaredLen))
  headers.set('cache-control', 'private, max-age=86400')

  // When the provider already advertises a size over the cap, don't bother
  // teeing/archiving — just stream the original body straight through.
  if (hasLen && declaredLen > MEDIA_MAX_STORE_BYTES) {
    return new Response(body, { status: 200, headers })
  }

  // Bound the number of CONCURRENT archive buffers: each one may hold up to
  // MEDIA_MAX_STORE_BYTES in RAM, so N parallel downloads without a cap could
  // multiply into hundreds of MB. Archiving is best-effort — when all slots
  // are busy we simply skip it (the file is served untouched and will be
  // archived on a later request), never queue and never block serving.
  if (archiveSlotsInUse >= MAX_CONCURRENT_ARCHIVES) {
    return new Response(body, { status: 200, headers })
  }
  archiveSlotsInUse++
  const [clientStream, archiveStream] = body.tee()
  void archiveBounded(messageId, archiveStream, mime, name).finally(() => {
    archiveSlotsInUse--
  })
  return new Response(clientStream, { status: 200, headers })
}

/** See serveAndArchive: cap on simultaneous in-memory archive buffers. */
const MAX_CONCURRENT_ARCHIVES = 4
let archiveSlotsInUse = 0

/**
 * Drain a tee'd media stream into memory ONLY up to MEDIA_MAX_STORE_BYTES, then
 * archive it. If the stream exceeds the cap it cancels its branch and skips the
 * write (the client branch keeps streaming unaffected). Fire-and-forget: never
 * throws into the request path.
 */
async function archiveBounded(
  messageId: string,
  stream: ReadableStream<Uint8Array>,
  mime: string | null,
  name: string | null,
): Promise<void> {
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MEDIA_MAX_STORE_BYTES) {
        // Too large to archive: release this branch so the tee stops buffering
        // for it. The client branch is independent and keeps streaming.
        await reader.cancel().catch(() => {})
        return
      }
      chunks.push(Buffer.from(value))
    }
    if (total === 0) return
    const buf = Buffer.concat(chunks, total)
    await storeMessageMediaBytes(messageId, buf, mime, name).catch(() => {})
  } catch {
    await reader.cancel().catch(() => {})
  }
}
