import { getSession } from '@/lib/auth'
import {
  getMessageOwner,
  getUrlMediaDescriptor,
  getWhatsappMediaDescriptor,
} from '@/lib/data'
import { proxiedFetch } from '@/lib/proxy-agent'
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
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession()
  if (!session) return new Response('Unauthorized', { status: 401 })

  const { id } = await params
  if (!id) return new Response('Bad request', { status: 400 })

  // Ownership check: the message must belong to a conversation this manager owns.
  const owner = await getMessageOwner(id, session.sub)
  if (!owner) return new Response('Not found', { status: 404 })

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
    const headers = new Headers()
    headers.set(
      'content-type',
      upstream.headers.get('content-type') ||
        info.data.mime_type ||
        desc.mime ||
        'application/octet-stream',
    )
    const len = upstream.headers.get('content-length')
    if (len) headers.set('content-length', len)
    headers.set('cache-control', 'private, max-age=86400')
    return new Response(upstream.body, { status: 200, headers })
  }

  // VK (like MAX/live-chat) has no worker: attachments carry a direct CDN url
  // stored in media_ref. We stream those bytes through the account's proxy so
  // the manager's browser never hits VK directly (consistent IP, no hotlink/CORS
  // issues) and the raw url is never exposed to the client.
  if (owner.channelType === 'vk') {
    const desc = await getUrlMediaDescriptor(id)
    if (!desc) return new Response('Media unavailable', { status: 404 })
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
    const headers = new Headers()
    headers.set(
      'content-type',
      upstream.headers.get('content-type') || desc.mime || 'application/octet-stream',
    )
    const len = upstream.headers.get('content-length')
    if (len) headers.set('content-length', len)
    headers.set('cache-control', 'private, max-age=86400')
    return new Response(upstream.body, { status: 200, headers })
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
