import { setBalance } from '@/lib/god-sites'
import {
  bare404,
  corsPreflight,
  mutationResponse,
  readBody,
  readRevision,
  resolveSite,
} from '../shared'

export const dynamic = 'force-dynamic'

/** Contract §2 #7 — set balance and currency. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const site = await resolveSite(params)
  if (!site) return bare404()
  const body = await readBody(req)
  const res = await setBalance(
    site.id,
    body?.balance,
    body?.currency,
    readRevision(req, body),
  )
  return mutationResponse(res)
}

export function OPTIONS() {
  return corsPreflight()
}
