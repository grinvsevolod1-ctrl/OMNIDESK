import { getSession } from '@/lib/auth'
import { getChannelOwner, getChannelOwnerForCurator } from '@/lib/data'
import { isWorkerConfigured, streamFromWorker } from '@/lib/worker-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Stream a sticker preview (webp/png) for a Telegram channel owned by the
 * signed-in manager. Proxies the worker's /sticker-thumb endpoint.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getSession()
  if (!session) return new Response('Unauthorized', { status: 401 })

  const sp = new URL(request.url).searchParams
  const channelId = sp.get('channelId') ?? ''
  const id = sp.get('id') ?? ''
  const accessHash = sp.get('accessHash') ?? ''
  const fileReference = sp.get('fileReference') ?? ''
  if (!channelId || !id) return new Response('Bad request', { status: 400 })

  const owner =
    session.role === 'curator'
      ? await getChannelOwnerForCurator(channelId, session.sub)
      : await getChannelOwner(channelId, session.sub)
  if (!owner || owner.channelType !== 'telegram') {
    return new Response('Not found', { status: 404 })
  }
  if (!isWorkerConfigured) {
    return new Response('Worker not configured', { status: 503 })
  }

  const qs = new URLSearchParams({
    channelId,
    id,
    accessHash,
    fileReference,
  })
  const upstream = await streamFromWorker(`/sticker-thumb?${qs.toString()}`)
  if (!upstream || !upstream.ok || !upstream.body) {
    return new Response('Sticker unavailable', {
      status: upstream?.status || 502,
    })
  }

  const headers = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) headers.set('content-type', ct)
  const cl = upstream.headers.get('content-length')
  if (cl) headers.set('content-length', cl)
  headers.set('cache-control', 'private, max-age=86400')

  return new Response(upstream.body, { status: 200, headers })
}
