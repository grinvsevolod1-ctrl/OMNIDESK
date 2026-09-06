import { getSession } from '@/lib/auth'
import { isMessengerUnlocked } from '@/lib/messenger-gate'
import { isGodUnlocked } from '@/lib/god-gate'
import {
  getMediaDiagnostics,
  getMessageOwner,
  getMessageOwnerAdmin,
  getMessageOwnerForCurator,
  getPersonalMediaDescriptor,
  getStoredEditMediaBytes,
  getStoredMediaBytes,
  getUrlMediaDescriptor,
  getWhatsappMediaDescriptor,
  MEDIA_MAX_STORE_BYTES,
  restoreMediaFromJobPayload,
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
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Any thrown error here (DB hiccup, provider fetch reject, disk read) used to
  // surface as a raw framework 500 in the browser console. Convert it into a
  // handled 502 and log the real cause so a broken image never spams 500s.
  try {
    return await handleMediaGet(request, ctx)
  } catch (err) {
    console.error('[v0][media] stream failed:', err)
    return new Response('Media unavailable', { status: 502 })
  }
}

async function handleMediaGet(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession()
  // The god messenger / god console are admin-wide surfaces: they may stream
  // ANY message's media once their own passcode gate cookie is verified. Those
  // gates are cryptographically independent of the normal login, so we honour
  // them EVEN WHEN an admin session is also present — otherwise an admin opening
  // the god messenger (role 'admin', session.sub = admin id) would be scoped by
  // manager ownership and every god-conversation photo would 404/502. A plain
  // manager session (no gate cookie) stays scoped to the conversations it owns.
  const gateUnlocked =
    (await isMessengerUnlocked()) || (await isGodUnlocked())
  if (!session && !gateUnlocked)
    return new Response('Unauthorized', { status: 401 })

  const { id } = await params
  if (!id) return new Response('Bad request', { status: 400 })

  // Ownership check: an unlocked god/messenger gate may stream ANY message; a
  // curator session is scoped to conversations transferred to THEM (recordTransfer
  // sets curator_id; see getMessageOwnerForCurator); otherwise a manager session
  // is scoped to conversations it owns.
  const owner = gateUnlocked
    ? await getMessageOwnerAdmin(id)
    : session!.role === 'curator'
      ? await getMessageOwnerForCurator(id, session!.sub)
      : await getMessageOwner(id, session!.sub)
  if (!owner) return new Response('Not found', { status: 404 })

  const search = new URL(request.url).searchParams

  // Owner-scoped diagnostics (same ownership gate as the bytes): explains WHY a
  // bubble shows «Медиа недоступно» — archive / job payload / provider id /
  // synthetic — as metadata only, so the cause can be read off in the browser
  // instead of correlating worker logs.
  if (search.get('diag') === '1') {
    return Response.json(await getMediaDiagnostics(id), {
      headers: { 'cache-control': 'no-store' },
    })
  }

  // Historical (pre-edit) version of the media, addressed by edit id. Ownership
  // is already established via the message id above.
  const editId = search.get('edit')
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

  // Legacy outbound media (sent before archive-at-send-time, or whose archive
  // write failed): the send job still holds the file for 7 days. Restore from
  // there and serve — the per-request twin of migration 158, so recovery does
  // not hinge on deploy timing and also covers god-synthetic dialogs where a
  // live re-download can never succeed.
  const fromJob = await restoreMediaFromJobPayload(id)
  if (fromJob) {
    return bytesResponse(fromJob.bytes, fromJob.mime, true)
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

  // Personal Telegram dialogs (god messenger / synthetic / outreach, transferred
  // to curators) are read LIVE from Telegram and their inbound media is never
  // persisted — so the generic `/media` bot pipeline can't find it and returns
  // 410. Stream it from the worker's personal endpoint instead, exactly like the
  // god messenger's own personal-media route does. (Archived/god-sent bytes are
  // already served above via getStoredMediaBytes.)
  if (owner.channelType === 'telegram_personal') {
    const desc = await getPersonalMediaDescriptor(id)
    if (!desc) return new Response('Media unavailable', { status: 404 })
    const personal = await streamFromWorker(
      `/personal/media?channelId=${encodeURIComponent(desc.channelId)}` +
        `&peer=${encodeURIComponent(desc.peer)}` +
        `&messageId=${encodeURIComponent(desc.providerMessageId)}`,
    )
    if (!personal || !personal.ok || !personal.body) {
      return new Response('Media unavailable', {
        status: personal?.status || 502,
      })
    }
    // Archive a bounded copy while streaming: personal/synthetic media is read
    // LIVE from Telegram and is NOT persisted at ingest, so a later re-fetch can
    // fail (410) once the far side edits/deletes it or the live descriptor goes
    // stale. Teeing the first successful load into media_blobs makes every
    // subsequent view durable and provider-independent — the same self-healing
    // the WhatsApp/VK paths already do above.
    const personalMime =
      personal.headers.get('content-type') || 'application/octet-stream'
    return serveAndArchive(id, personal, personalMime, null)
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

  // Same self-healing archive as above: once the worker re-downloads the bytes
  // from the provider, keep a bounded copy so the file survives the contact
  // editing/deleting it (and future loads skip the worker round-trip entirely).
  const upstreamMime =
    upstream.headers.get('content-type') || 'application/octet-stream'
  return serveAndArchive(id, upstream, upstreamMime, null)
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
