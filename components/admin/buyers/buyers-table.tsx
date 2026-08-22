'use client'

/**
 * Админ-таблица медиабайеров: их источники трафика (чипами, ведут на
 * /admin/sources) и общие действия аккаунта (блокировка, сброс пароля,
 * удаление — ManagerActions).
 */
import Link from 'next/link'
import { Megaphone, Radio } from 'lucide-react'
import { ManagerActions } from '@/components/admin/manager-actions'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { formatMskDate as formatDate } from '@/lib/time'
import type { Manager } from '@/lib/types'

export interface BuyerRow extends Manager {
  sources: { id: string; name: string; isActive: boolean }[]
}

function StatusPill({ status }: { status: Manager['status'] }) {
  return (
    <Badge
      variant="outline"
      className={
        status === 'active'
          ? 'gap-1.5 border-transparent bg-success/15 text-success'
          : 'gap-1.5 border-transparent bg-muted text-muted-foreground'
      }
    >
      <span
        className={
          status === 'active'
            ? 'size-1.5 rounded-full bg-success'
            : 'size-1.5 rounded-full bg-muted-foreground'
        }
      />
      {status === 'active' ? 'Активен' : 'Заблокирован'}
    </Badge>
  )
}

function SourceChips({
  sources,
}: {
  sources: BuyerRow['sources']
}) {
  if (sources.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        Нет источников —{' '}
        <Link href="/admin/sources" className="underline underline-offset-2">
          назначить
        </Link>
      </span>
    )
  }
  return (
    <div className="flex max-w-md flex-wrap items-center gap-1.5">
      {sources.map((s) => (
        <Badge
          key={s.id}
          variant="outline"
          className={
            s.isActive
              ? 'gap-1.5 border-transparent bg-muted text-foreground'
              : 'gap-1.5 border-transparent bg-muted text-muted-foreground line-through'
          }
          title={s.isActive ? s.name : `${s.name} · выключен`}
        >
          <Radio className="size-3" />
          {s.name}
        </Badge>
      ))}
    </div>
  )
}

export function BuyersTable({ buyers }: { buyers: BuyerRow[] }) {
  return (
    <>
      <Card className="hidden overflow-hidden lg:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-3 font-medium">Имя</th>
              <th className="px-5 py-3 font-medium">Источники</th>
              <th className="px-5 py-3 font-medium">Статус</th>
              <th className="px-5 py-3 font-medium">Создан</th>
              <th className="px-5 py-3 font-medium text-right">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {buyers.map((b) => (
              <tr key={b.id} className="hover:bg-muted/30">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2 font-medium">
                    <Megaphone className="size-4 text-muted-foreground" />
                    {b.name}
                  </div>
                  <div className="text-xs text-muted-foreground">{b.email}</div>
                  {b.username ? (
                    <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                      @{b.username}
                    </div>
                  ) : null}
                </td>
                <td className="px-5 py-3">
                  <SourceChips sources={b.sources} />
                </td>
                <td className="px-5 py-3">
                  <StatusPill status={b.status} />
                </td>
                <td className="px-5 py-3 text-xs text-muted-foreground">
                  {formatDate(b.createdAt)}
                </td>
                <td className="px-5 py-3 text-right">
                  <ManagerActions manager={b} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="flex flex-col gap-3 lg:hidden">
        {buyers.map((b) => (
          <Card key={b.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{b.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {b.email}
                </p>
              </div>
              <ManagerActions manager={b} />
            </div>
            <div className="mt-3 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusPill status={b.status} />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Источники
                </span>
                <SourceChips sources={b.sources} />
              </div>
              <span className="text-xs text-muted-foreground">
                {formatDate(b.createdAt)}
              </span>
            </div>
          </Card>
        ))}
      </div>
    </>
  )
}
