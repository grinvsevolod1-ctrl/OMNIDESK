'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  ArrowUpRight,
  Ban,
  CheckCircle2,
  Copy,
  Search,
  Users,
} from 'lucide-react'
import {
  secretSetManagerStatusAction,
  type ActionResult,
} from '@/app/actions/admin-secret'
import { EmptyState } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { Manager } from '@/lib/types'
import { copyText } from './utils'
import { ManagerTempPassword, ManagerTwofa } from './manager-security'
import { ImpersonateButton } from './impersonate-button'

/* ------------------------------ Managers ------------------------------ */

type GroupId = 'managers' | 'curators' | 'heads' | 'buyers'

const GROUPS: {
  id: GroupId
  label: string
  manageHref: string
  manageLabel: string
  emptyTitle: string
}[] = [
  {
    id: 'managers',
    label: 'Менеджеры',
    manageHref: '/admin/managers',
    manageLabel: 'Управление менеджерами',
    emptyTitle: 'Менеджеры не найдены',
  },
  {
    id: 'curators',
    label: 'По кадрам',
    manageHref: '/admin/curators',
    manageLabel: 'Управление кадрами',
    emptyTitle: 'Менеджеры по кадрам не найдены',
  },
  {
    id: 'heads',
    label: 'Руководители',
    manageHref: '/admin/heads',
    manageLabel: 'Управление руководителями',
    emptyTitle: 'Руководители не найдены',
  },
  {
    id: 'buyers',
    label: 'Байеры',
    manageHref: '/admin/buyers',
    manageLabel: 'Управление байерами',
    emptyTitle: 'Медиабайеры не найдены',
  },
]

export function ManagersTab({
  managers,
  curators,
  heads,
  buyers,
  pending,
  run,
}: {
  managers: Manager[]
  /** HR-curator accounts — same controls (temp password, block) as managers. */
  curators: Manager[]
  /** Head accounts. */
  heads: Manager[]
  /** Media-buyer accounts. */
  buyers: Manager[]
  pending: boolean
  run: (a: () => Promise<ActionResult>, onDone?: () => void) => void
}) {
  const [q, setQ] = useState('')
  const [group, setGroup] = useState<GroupId>('managers')

  const sourceByGroup: Record<GroupId, Manager[]> = {
    managers,
    curators,
    heads,
    buyers,
  }
  const source = sourceByGroup[group]
  const active = GROUPS.find((g) => g.id === group) ?? GROUPS[0]
  const filtered = source.filter(
    (m) =>
      m.name.toLowerCase().includes(q.toLowerCase()) ||
      m.email.toLowerCase().includes(q.toLowerCase()),
  )

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-3 lg:flex-row lg:items-center">
          {/* Переключатель типов аккаунтов: продажи / кадры / руководители / байеры */}
          <div
            role="tablist"
            aria-label="Тип аккаунтов"
            className="flex w-fit shrink-0 flex-wrap rounded-lg bg-muted/60 p-0.5"
          >
            {GROUPS.map((g) => (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={group === g.id}
                onClick={() => setGroup(g.id)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  group === g.id
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Поиск по имени или email"
              className="pl-8"
            />
          </div>
        </div>
        <Link
          href={active.manageHref}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'sm' }),
            'gap-1.5',
          )}
        >
          {active.manageLabel}
          <ArrowUpRight className="size-4" />
        </Link>
      </div>

      {filtered.length ? (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Имя</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead className="text-right">Действия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {m.name}
                      {m.onLunch ? (
                        <Badge
                          variant="outline"
                          className="border-warning/40 text-warning"
                        >
                          На обеде
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {m.email}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        m.status === 'active'
                          ? 'border-success/40 bg-success/10 text-success'
                          : 'border-destructive/40 bg-destructive/10 text-destructive',
                      )}
                    >
                      {m.status === 'active' ? 'Активен' : 'Заблокирован'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1.5">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => copyText(m.id)}
                              className="gap-1.5"
                            >
                              <Copy className="size-3.5" />
                              ID
                            </Button>
                          }
                        />
                        <TooltipContent>
                          Скопировать ID аккаунта
                        </TooltipContent>
                      </Tooltip>
                      <ImpersonateButton account={m} />
                      <ManagerTempPassword manager={m} />
                      <ManagerTwofa manager={m} />
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={pending}
                              onClick={() =>
                                run(() =>
                                  secretSetManagerStatusAction(
                                    m.id,
                                    m.status === 'active'
                                      ? 'blocked'
                                      : 'active',
                                  ),
                                )
                              }
                              className={cn(
                                'gap-1.5',
                                m.status === 'active' && 'text-destructive',
                              )}
                            >
                              {m.status === 'active' ? (
                                <>
                                  <Ban className="size-3.5" /> Блок
                                </>
                              ) : (
                                <>
                                  <CheckCircle2 className="size-3.5" /> Разблок
                                </>
                              )}
                            </Button>
                          }
                        />
                        <TooltipContent>
                          {m.status === 'active'
                            ? 'Заблокировать вход — активные сессии завершатся'
                            : 'Снять блокировку и вернуть доступ'}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="p-6">
          <EmptyState
            icon={Users}
            title={active.emptyTitle}
            description="Измените запрос поиска или создайте аккаунт в разделе управления."
          />
        </div>
      )}
    </Card>
  )
}
