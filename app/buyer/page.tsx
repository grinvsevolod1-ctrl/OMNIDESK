import {
  listBuyerLeadsAction,
  listBuyerSourcesAction,
} from '@/app/actions/buyer'
import { BuyerOverview } from '@/components/buyer/buyer-overview'

export const dynamic = 'force-dynamic'

/**
 * Раздел медиабайера: обзор своих источников (статистика день/«долёты»)
 * и все лиды этих источников с единым поиском и фильтрами. Read-only.
 */
export default async function BuyerPage() {
  const [sources, leads] = await Promise.all([
    listBuyerSourcesAction(),
    listBuyerLeadsAction(),
  ])
  return <BuyerOverview initialSources={sources} initialLeads={leads} />
}
