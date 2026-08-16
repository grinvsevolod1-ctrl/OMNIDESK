import Link from 'next/link'
import { X } from 'lucide-react'
import { ContactsAdmin } from '@/components/admin/contacts-admin'
import { PageHeader } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { requireAdmin } from '@/lib/auth'
import { listContactsByChannel } from '@/lib/data'
import { listSources } from '@/lib/data/sources'

export const dynamic = 'force-dynamic'

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>
}) {
  await requireAdmin()
  const { source } = await searchParams

  // Drill-down из Обзора: ?source=<id> сужает базу до каналов источника.
  let sourceName: string | null = null
  let channelIds: string[] | undefined
  if (source) {
    const match = (await listSources()).find((s) => s.id === source)
    if (match) {
      sourceName = match.name
      // Источник без каналов: пустой фильтр показал бы ВСЁ — подставляем
      // заведомо пустое множество, чтобы показать «ничего».
      channelIds =
        match.channels.length > 0
          ? match.channels.map((c) => c.id)
          : ['00000000-0000-0000-0000-000000000000']
    }
  }

  const groups = await listContactsByChannel(channelIds)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Контакты"
        description="База лидов по всем каналам. Идентификаторы видны только администратору."
      />
      {sourceName ? (
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="gap-1.5 py-1 pl-2.5 pr-1">
            Источник: {sourceName}
            <Link
              href="/admin/contacts"
              aria-label="Сбросить фильтр по источнику"
              className="rounded-full p-0.5 hover:bg-muted-foreground/20"
            >
              <X className="size-3.5" />
            </Link>
          </Badge>
        </div>
      ) : null}
      <ContactsAdmin groups={groups} />
    </div>
  )
}
