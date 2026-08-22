import { Megaphone } from 'lucide-react'
import { listBuyersAdminAction } from '@/app/actions/admin-buyers'
import { CreateBuyerDialog } from '@/components/admin/buyers/create-buyer-dialog'
import { BuyersTable } from '@/components/admin/buyers/buyers-table'
import { EmptyState, PageHeader } from '@/components/page-parts'

export default async function BuyersPage() {
  const { buyers } = await listBuyersAdminAction()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Медиабайеры"
        description="Медиабайер приводит трафик и видит статистику и лидов только своих источников. Источники и их менеджеры настраиваются на странице «Источники»."
        action={<CreateBuyerDialog />}
      />
      {buyers.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="Медиабайеров пока нет"
          description="Создайте медиабайера и закрепите за ним источники трафика на странице «Источники»."
          action={<CreateBuyerDialog />}
        />
      ) : (
        <BuyersTable buyers={buyers} />
      )}
    </div>
  )
}
