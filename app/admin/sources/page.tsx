import { Radio } from 'lucide-react'
import { listSourcesAdminAction } from '@/app/actions/admin-sources'
import { SourceDialog } from '@/components/admin/sources/source-dialog'
import { SourcesTable } from '@/components/admin/sources/sources-table'
import { EmptyState, PageHeader } from '@/components/page-parts'

export default async function SourcesPage() {
  const { sources, buyers, allManagers } = await listSourcesAdminAction()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Источники трафика"
        description="Источник ведёт медиабайер; подключённые менеджеры наследуют его окно статистики. Лиды в дневном окне — «день», вне окна — «долёты»."
        action={<SourceDialog buyers={buyers} />}
      />
      {sources.length === 0 ? (
        <EmptyState
          icon={Radio}
          title="Источников пока нет"
          description="Создайте источник, назначьте байера и подключите менеджеров — новые лиды начнут атрибутироваться автоматически."
          action={<SourceDialog buyers={buyers} />}
        />
      ) : (
        <SourcesTable
          sources={sources}
          buyers={buyers}
          allManagers={allManagers}
        />
      )}
    </div>
  )
}
