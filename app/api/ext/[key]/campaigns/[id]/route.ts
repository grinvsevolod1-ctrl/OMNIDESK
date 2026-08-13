import { deleteCampaign, patchCampaign } from '@/lib/god-sites'
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

/** Contract §2 #3 — patch campaign fields. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ key: string; id: string }> },
) {
  const site = await resolveSite(params)
  if (!site) return bare404()
  const { id } = await params
  const body = await readBody(req)
  const res = await patchCampaign(site.id, id, body, readRevision(req, body))
  if (!res.ok) return mutationResponse(res)
  const campaign = res.state.campaigns.find((c) => c.id === id)
  return json({ ...(campaign ?? {}), revision: res.revision })
}

/** Contract §2 #5 — delete a campaign. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ key: string; id: string }> },
) {
  const site = await resolveSite(params)
  if (!site) return bare404()
  const { id } = await params
  const res = await deleteCampaign(site.id, id, readRevision(req, null))
  return mutationResponse(res)
}

export function OPTIONS() {
  return corsPreflight()
}
