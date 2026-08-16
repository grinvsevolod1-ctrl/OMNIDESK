import { PageHeader } from '@/components/page-parts'
import { TelemostAdmin } from '@/components/admin/telemost-admin'
import { getTelemostStatus } from '@/lib/data'

export default async function AdminTelemostPage() {
  const status = await getTelemostStatus()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Телемост"
        description="Подключите Яндекс Телемост, чтобы менеджеры могли создавать видеовстречи из диалогов."
      />
      <TelemostAdmin status={status} />
    </div>
  )
}
