import { ContactsAdmin } from '@/components/admin/contacts-admin'
import { PageHeader } from '@/components/page-parts'
import { requireAdmin } from '@/lib/auth'
import { listContactsByChannel } from '@/lib/data'

export const dynamic = 'force-dynamic'

export default async function ContactsPage() {
  await requireAdmin()
  const groups = await listContactsByChannel()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Контакты"
        description="База лидов по всем каналам. Идентификаторы видны только администратору."
      />
      <ContactsAdmin groups={groups} />
    </div>
  )
}
