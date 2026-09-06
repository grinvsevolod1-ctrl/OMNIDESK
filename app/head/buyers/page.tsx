import { Megaphone } from 'lucide-react'
import { requireHead } from '@/lib/auth'
import { listBuyersWithTotalsAction } from '@/app/actions/source-finance'
import { BuyersTable } from '@/components/admin/buyers/buyers-table'
import { EmptyState, PageHeader } from '@/components/page-parts'

export const dynamic = 'force-dynamic'

/**
 * Раздел руководителя «Байеры» — те же компоненты, что у админа, но actions
 * скоупят выборку по байерам его команды (перечитка из БД). Руководитель видит
 * отчётность и вносит депозиты только своим байерам.
 */
export default async function HeadBuyersPage() {
  await requireHead()
  const { buyers } = await listBuyersWithTotalsAction()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Мои байеры"
        description="Байеры вашей команды. Выберите байера, чтобы увидеть отчётность и внести депозит (бюджет)."
      />
      {buyers.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="За вами не закреплены байеры"
          description="Закрепить байеров за вами может администратор через команды."
        />
      ) : (
        <BuyersTable buyers={buyers} />
      )}
    </div>
  )
}
