import { getSession } from '@/lib/auth'
import {
  getMessageEditHistory,
  getMessageOwner,
  getMessageOwnerForCurator,
} from '@/lib/data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Edit history for a single message (JSON), oldest version first.
 *
 * The panel fetches this on demand when the operator expands the "изменено"
 * marker on a message, so the full before/after trail (including each version's
 * archived media) is only loaded when actually viewed. Ownership is enforced:
 * the message must belong to a conversation the signed-in manager owns.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession()
  if (!session) return json({ error: 'unauthorized' }, 401)

  const { id } = await params
  if (!id) return json({ error: 'bad_request' }, 400)

  const owner =
    session.role === 'curator'
      ? await getMessageOwnerForCurator(id, session.sub)
      : await getMessageOwner(id, session.sub)
  if (!owner) return json({ error: 'not_found' }, 404)

  const history = await getMessageEditHistory(id)
  return json({ history })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
