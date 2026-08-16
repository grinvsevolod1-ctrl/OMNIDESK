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
import { cn } from '@/lib/utils'
import type { Manager } from '@/lib/types'
import { copyText } from './utils'
import { ManagerTempPassword, ManagerTwofa } from './manager-security'

/* ------------------------------ Managers ------------------------------ */

export function ManagersTab({
  managers,
  curators,
  pending,
  run,
}: {
  managers: Manager[]
  /** HR-curator accounts — same controls (temp password, block) as managers. */
  curators: Manager[]
  pending: boolean
  run: (a: () => Promise<ActionResult>, onDone?: () => void) => void
}) {
  const [q, setQ] = useState('')
  const [group, setGroup] = useState<'managers' | 'curators'>('managers')
  const source = group === 'managers' ? managers : curators
  const filtered = source.filter(
    (m) =>
      m.name.toLowerCase().includes(q.toLowerCase()) ||
      m.email.toLowerCase().includes(q.toLowerCase()),
  )

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
          {/* Переключатель: менеджеры продаж / менеджеры по кадрам */}
          <div
            role="tablist"
            aria-label="Тип аккаунтов"
            className="flex w-fit shrink-0 rounded-lg bg-muted/60 p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={group === 'managers'}
              onClick={() => setGroup('managers')}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                group === 'managers'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Менеджеры
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={group === 'curators'}
              onClick={() => setGroup('curators')}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                group === 'curators'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              По кадрам
            </button>
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
          href={group === 'managers' ? '/admin/managers' : '/admin/curators'}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'sm' }),
            'gap-1.5',
          )}
        >
          {group === 'managers'
            ? 'Управление менеджерами'
            : 'Управление кадрами'}
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
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => copyText(m.id)}
                        className="gap-1.5"
                      >
                        <Copy className="size-3.5" />
                        ID
                      </Button>
                      <ManagerTempPassword manager={m} />
                      <ManagerTwofa manager={m} />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          run(() =>
                            secretSetManagerStatusAction(
                              m.id,
                              m.status === 'active' ? 'blocked' : 'active',
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
            title={
              group === 'managers'
                ? 'Менеджеры не найдены'
                : 'Менеджеры по кадрам не найдены'
            }
            description="Измените запрос поиска или создайте аккаунт в разделе управления."
          />
        </div>
      )}
    </Card>
  )
}
