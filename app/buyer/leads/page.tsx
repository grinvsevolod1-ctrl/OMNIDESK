import {
  listBuyerLeadsAction,
  listBuyerSourcesAction,
} from '@/app/actions/buyer'
import { BuyerLeads } from '@/components/buyer/buyer-leads'

export const dynamic = 'force-dynamic'

/**
 * Раздел медиабайера, вкладка «Лиды»: все лиды его источников с единым
 * поиском, фильтрами по источнику/статусу, сортировкой и пагинацией.
 */
export default async function BuyerLeadsPage() {
  const [sources, leads] = await Promise.all([
    listBuyerSourcesAction(),
    listBuyerLeadsAction(),
  ])
  return <BuyerLeads sources={sources} leads={leads} />
}
