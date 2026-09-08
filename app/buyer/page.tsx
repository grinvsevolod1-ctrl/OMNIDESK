import { listBuyerSourcesAction } from '@/app/actions/buyer'
import { BuyerOverview } from '@/components/buyer/buyer-overview'

export const dynamic = 'force-dynamic'

/**
 * Раздел медиабайера, вкладка «Обзор»: карточки своих источников со
 * статистикой день/«долёты». Лиды — в отдельной вкладке «Лиды». Read-only.
 */
export default async function BuyerPage() {
  const sources = await listBuyerSourcesAction()
  return <BuyerOverview initialSources={sources} />
}
