import { setCampaignStatus } from '@/lib/god-sites'
import {
  bare404,
  corsPreflight,
  mutationResponse,
  readBody,
  readRevision,
  resolveSite,
} from '../../../shared'

export const dynamic = 'force-dynamic'

/** Contract §2 #6 — start/stop a campaign. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string; id: string }> },
) {
  const site = await resolveSite(params)
  if (!site) return bare404()
  const { id } = await params
  const body = await readBody(req)
  const res = await setCampaignStatus(
    site.id,
    id,
    body?.status,
    readRevision(req, body),
  )
  return mutationResponse(res)
}

export function OPTIONS() {
  return corsPreflight()
}
