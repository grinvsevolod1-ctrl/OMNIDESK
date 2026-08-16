import { QuickRepliesManager } from '@/components/manager/quick-replies-manager'
import { PageHeader } from '@/components/page-parts'
import { requireManager } from '@/lib/auth'
import { listQuickReplies } from '@/lib/data'

export default async function QuickRepliesPage() {
  const session = await requireManager()
  const replies = await listQuickReplies(session.sub)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader
        title="Автоответы"
        description="Заготовленные ответы, которые появляются над полем ввода в диалоге. Нажмите на ответ, чтобы вставить его в сообщение."
      />
      <QuickRepliesManager initial={replies} />
    </div>
  )
}
