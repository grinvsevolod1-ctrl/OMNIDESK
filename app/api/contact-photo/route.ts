import { getSession } from '@/lib/auth'
import { query } from '@/lib/db'
import {
  getCachedContactAvatar,
  getContactAvatarBytes,
  storeContactAvatar,
} from '@/lib/data/contact-avatars'
import { fetchContactAvatar, isWorkerConfigured } from '@/lib/worker-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Serve a contact's Telegram profile photo for the inbox avatar.
 *
 * Flow: verify the signed-in user can see the conversation (owning manager,
 * assigned curator, or admin/god) → serve a fresh cached blob if we have one →
 * otherwise ask the worker to download it, cache the result (bytes OR a
 * "no photo" negative), and serve. A 404 tells the browser <img> to fall back
 * to the initials avatar; the negative cache stops us re-hitting the worker on
 * every scroll.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getSession()
  if (!session) return notFound()

  const url = new URL(request.url)
  const conversationId = url.searchParams.get('conversationId') ?? ''
  if (!conversationId) return notFound()

  // Resolve channel + contact + visibility in one query. Telegram-only: other
  // channels don't expose profile photos we can download.
  const rows = await query<{
    channel_id: string
    channel_type: string
    contact_handle: string
    manager_id: string
    curator_id: string | null
  }>(
    `SELECT c.channel_id, c.channel_type, c.contact_handle,
            c.manager_id, c.curator_id
       FROM conversations c
      WHERE c.id = $1
      LIMIT 1`,
    [conversationId],
  )
  const row = rows[0]
  if (!row) return notFound()

  const role = session.role
  const uid = session.sub
  const canSee =
    role === 'admin' ||
    (role === 'manager' && row.manager_id === uid) ||
    (role === 'curator' && row.curator_id === uid) ||
    // Heads can view their reports' threads; keep this permissive (visibility is
    // already enforced elsewhere) so avatars aren't the odd one out.
    role === 'head'
  if (!canSee) return notFound()

  if (!row.channel_type.startsWith('telegram') || !row.contact_handle) {
    return notFound()
  }

  // 1) Fresh cache hit.
  const cached = await getCachedContactAvatar(row.channel_id, row.contact_handle)
  if (cached?.fresh) {
    if (!cached.hasPhoto || !cached.mediaBlobId) return notFound()
    const blob = await getContactAvatarBytes(cached.mediaBlobId)
    if (blob) return imageResponse(blob.bytes, blob.mime)
    // Blob went missing (offloaded/deleted) — fall through to a re-fetch.
  }

  // 2) Cold / stale — ask the worker.
  if (!isWorkerConfigured) {
    if (cached?.mediaBlobId) {
      const blob = await getContactAvatarBytes(cached.mediaBlobId)
      if (blob) return imageResponse(blob.bytes, blob.mime)
    }
    return notFound()
  }

  const fetched = await fetchContactAvatar(row.channel_id, row.contact_handle)

  if (fetched === 'none') {
    await storeContactAvatar(row.channel_id, row.contact_handle, null)
    return notFound()
  }

  if (!fetched) {
    // Worker offline / transient: serve a stale blob if we still have one,
    // else 404 (do NOT write a negative — we want to retry once it's back).
    if (cached?.mediaBlobId) {
      const blob = await getContactAvatarBytes(cached.mediaBlobId)
      if (blob) return imageResponse(blob.bytes, blob.mime)
    }
    return notFound()
  }

  await storeContactAvatar(row.channel_id, row.contact_handle, fetched)
  return imageResponse(fetched.bytes, fetched.mime)
}

function imageResponse(bytes: Buffer, mime: string): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': mime || 'image/jpeg',
      // Cache in the browser for a day; the server cache (7d) is the real TTL.
      'cache-control': 'private, max-age=86400',
    },
  })
}

/** 404 the <img> turns into its initials fallback; never cached. */
function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { 'cache-control': 'no-store' },
  })
}
