import { createCampaign } from '@/lib/god-sites'
import { rateLimit } from '@/lib/rate-limit'
import {
  bare404,
  corsPreflight,
  json,
  mutationResponse,
  readBody,
  readRevision,
  resolveSite,
} from '../shared'

export const dynamic = 'force-dynamic'

/** Contract §2 #4 — create a campaign. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const site = await resolveSite(params)
  if (!site) return bare404()

  // Create is the easiest endpoint to abuse into unbounded growth.
  const rl = await rateLimit(`ext-create:${site.id}`, 30, 60_000)
  if (!rl.allowed) return json({ error: 'rate limited' }, 429)

  const body = await readBody(req)
  const res = await createCampaign(site.id, body, readRevision(req, body))
  if (!res.ok) return mutationResponse(res)

  const created = res.state.campaigns.find((c) => c.id === res.createdId)
  return json({ ...(created ?? {}), revision: res.revision })
}

export function OPTIONS() {
  return corsPreflight()
}
