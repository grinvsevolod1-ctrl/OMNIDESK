import { notFound } from 'next/navigation'
import { getBuyerSourceAction } from '@/app/actions/buyer'
import { getBuyerSourceFinanceAction } from '@/app/actions/source-finance'
import { BuyerSourceDetail } from '@/components/buyer/source-detail'

export const dynamic = 'force-dynamic'

/**
 * Детальная страница источника байера: баланс, леджер депозитов (с
 * подтверждением/отклонением), дневной лог трат и метрики. Скоуп — только
 * источник текущего байера (иначе 404).
 */
export default async function BuyerSourcePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const source = await getBuyerSourceAction(id)
  if (!source) notFound()
  const finance = await getBuyerSourceFinanceAction(id)
  return <BuyerSourceDetail source={source} initialFinance={finance} />
}
