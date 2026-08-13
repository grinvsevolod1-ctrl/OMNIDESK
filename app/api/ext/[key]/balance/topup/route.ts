import { topupBalance } from '@/lib/god-sites'
import { rateLimit } from '@/lib/rate-limit'
import {
  bare404,
  corsPreflight,
  json,
  mutationResponse,
  readBody,
  readRevision,
  resolveSite,
} from '../../shared'

export const dynamic = 'force-dynamic'

/** Contract §2 #8 — top up the balance; returns the new balance. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const site = await resolveSite(params)
  if (!site) return bare404()

  // Contract §6 asks for limits on topup so a retry can't double-apply
  // uncontrollably.
  const rl = await rateLimit(`ext-topup:${site.id}`, 30, 60_000)
  if (!rl.allowed) return json({ error: 'rate limited' }, 429)

  const body = await readBody(req)
  const res = await topupBalance(site.id, body?.amount, readRevision(req, body))
  if (!res.ok) return mutationResponse(res)
  return json({ balance: res.state.balance, revision: res.revision })
}

export function OPTIONS() {
  return corsPreflight()
}
