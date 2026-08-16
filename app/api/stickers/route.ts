import { getSession } from '@/lib/auth'
import { getChannelOwner } from '@/lib/data'
import { fetchStickers, isWorkerConfigured } from '@/lib/worker-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * List the sticker palette (favourited + recent) for a Telegram channel owned
 * by the signed-in manager. Returns an empty list (200) when the worker is
 * offline so the UI degrades gracefully instead of erroring.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getSession()
  if (!session) return new Response('Unauthorized', { status: 401 })

  const channelId = new URL(request.url).searchParams.get('channelId') ?? ''
  if (!channelId) return new Response('Bad request', { status: 400 })

  const owner = await getChannelOwner(channelId, session.sub)
  if (!owner) return new Response('Not found', { status: 404 })
  if (owner.channelType !== 'telegram') {
    return Response.json({ stickers: [] })
  }
  if (!isWorkerConfigured) {
    return Response.json({ stickers: [] })
  }

  const stickers = await fetchStickers(channelId)
  return Response.json({ stickers: stickers ?? [] })
}
