import { Megaphone } from 'lucide-react'
import { listBuyersWithTotalsAction } from '@/app/actions/source-finance'
import { CreateBuyerDialog } from '@/components/admin/buyers/create-buyer-dialog'
import { BuyersTable } from '@/components/admin/buyers/buyers-table'
import { EmptyState, PageHeader } from '@/components/page-parts'

export const dynamic = 'force-dynamic'

export default async function BuyersPage() {
  const { buyers } = await listBuyersWithTotalsAction()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Медиабайеры"
        description="Байеры приводят трафик и ведут свои источники. Выберите байера, чтобы увидеть отчётность и внести депозит (бюджет)."
        action={<CreateBuyerDialog />}
      />
      {buyers.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="Медиабайеров пока нет"
          description="Создайте медиабайера — источники он добавит и настроит сам из своего кабинета."
          action={<CreateBuyerDialog />}
        />
      ) : (
        <BuyersTable buyers={buyers} />
      )}
    </div>
  )
}
