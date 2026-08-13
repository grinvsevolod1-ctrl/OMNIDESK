import { normalizePeriod, stateForPeriod } from '@/lib/god-sites'
import { bare404, corsPreflight, json, resolveSite } from '../shared'

export const dynamic = 'force-dynamic'

/** Contract §2 #1 — full cabinet state for the requested period. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const site = await resolveSite(params, { touch: true })
  if (!site) return bare404()
  const period = normalizePeriod(
    new URL(req.url).searchParams.get('period') ?? undefined,
  )
  return json(stateForPeriod(site.state, period, site.revision))
}

export function OPTIONS() {
  return corsPreflight()
}
