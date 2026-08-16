import { BookOpen } from 'lucide-react'
import Link from 'next/link'
import { LivechatAdmin } from '@/components/admin/livechat-admin'
import { PageHeader } from '@/components/page-parts'
import { Button } from '@/components/ui/button'
import { requireAdmin } from '@/lib/auth'
import { listLivechatChannels, listManagers } from '@/lib/data'

export default async function AdminLivechatPage() {
  await requireAdmin()
  const [channels, managers] = await Promise.all([
    listLivechatChannels(),
    listManagers(),
  ])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Онлайн-чат"
        description="Подключайте виджеты онлайн-чата на сайт и назначайте каждый менеджеру."
        action={
          <Button variant="outline" size="sm" render={<Link href="/admin/docs" />}>
            <BookOpen className="size-4" />
            <span>Документация</span>
          </Button>
        }
      />

      {managers.length === 0 ? (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning">
          Сначала создайте менеджера — каждый онлайн-чат должен быть назначен
          кому-то.
        </p>
      ) : null}

      <LivechatAdmin channels={channels} managers={managers} />
    </div>
  )
}
