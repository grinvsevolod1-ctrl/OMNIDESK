'use client'

import { useState, useTransition } from 'react'
import { ArrowRightLeft, Loader2, MapPin, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  listAllLeadsAdminAction,
  transferLeadAdminAction,
} from '@/app/actions/lead-cards'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import type { CuratorWithLoad, LeadCard } from '@/lib/data/lead-cards'
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
  leadStatusLabel,
  needsDailyStatusUpdate,
} from '@/lib/lead-status'
import { APP_TIME_ZONE } from '@/lib/time'
import { cn } from '@/lib/utils'

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  })
}

const PAGE_SIZE = 50

/**
 * Admin overview of ALL transferred leads: filters by curator/status/city,
 * an "orphaned" mode surfacing leads whose curator was deleted, and a
 * reassign action for every row.
 */
export function AllLeadsSection({
  initialLeads,
  initialTotal,
  orphanedCount,
  curators,
}: {
  initialLeads: LeadCard[]
  initialTotal: number
  orphanedCount: number
  curators: CuratorWithLoad[]
}) {
  const [leads, setLeads] = useState(initialLeads)
  const [total, setTotal] = useState(initialTotal)
  const [offset, setOffset] = useState(0)
  const [curatorId, setCuratorId] = useState<string>('')
  const [status, setStatus] = useState<string>('')
  const [city, setCity] = useState('')
  const [orphanedOnly, setOrphanedOnly] = useState(false)
  const [pending, startTransition] = useTransition()

  function reload(next: {
    curatorId?: string
    status?: string
    city?: string
    orphanedOnly?: boolean
    offset?: number
  }) {
    const f = {
      curatorId: next.curatorId ?? curatorId,
      status: next.status ?? status,
      city: next.city ?? city,
      orphanedOnly: next.orphanedOnly ?? orphanedOnly,
      offset: next.offset ?? 0,
    }
    startTransition(async () => {
      try {
        const res = await listAllLeadsAdminAction({
          curatorId: f.curatorId || null,
          status: f.status || null,
          city: f.city || null,
          orphanedOnly: f.orphanedOnly,
          limit: PAGE_SIZE,
          offset: f.offset,
        })
        setLeads(res.leads)
        setTotal(res.total)
        setOffset(f.offset)
      } catch {
        toast.error('Не удалось загрузить лиды')
      }
    })
  }

  function transfer(leadId: string, toCuratorId: string) {
    startTransition(async () => {
      const res = await transferLeadAdminAction({
        leadCardId: leadId,
        curatorId: toCuratorId,
      })
      if (res.ok) {
        toast.success(res.message)
        reload({ offset })
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Все лиды</h2>
          <p className="text-sm text-muted-foreground">
            Все переданные лиды по всем кураторам. Всего: {total}.
          </p>
        </div>
        {orphanedCount > 0 ? (
          <button
            type="button"
            onClick={() => {
              const next = !orphanedOnly
              setOrphanedOnly(next)
              reload({ orphanedOnly: next })
            }}
            className={cn(
              'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              orphanedOnly
                ? 'border-transparent bg-destructive/15 text-destructive'
                : 'border-destructive/40 text-destructive hover:bg-destructive/10',
            )}
          >
            Без куратора: {orphanedCount}
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={curatorId}
          onChange={(e) => {
            setCuratorId(e.target.value)
            reload({ curatorId: e.target.value })
          }}
          disabled={orphanedOnly}
          className="h-9 rounded-md border border-input bg-background px-2.5 text-sm"
          aria-label="Фильтр по куратору"
        >
          <option value="">Все кураторы</option>
          {curators.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.city ? ` — ${c.city}` : ''}
            </option>
          ))}
        </select>

        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            reload({ status: e.target.value })
          }}
          className="h-9 rounded-md border border-input bg-background px-2.5 text-sm"
          aria-label="Фильтр по статусу"
        >
          <option value="">Все статусы</option>
          <option value="none">Без статуса</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {LEAD_STATUS_LABELS[s]}
            </option>
          ))}
        </select>

        <Input
          value={city}
          onChange={(e) => setCity(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              reload({ city })
            }
          }}
          placeholder="Город…"
          className="h-9 w-36"
          aria-label="Фильтр по городу"
        />

        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => reload({})}
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Обновить
        </Button>
      </div>

      <Card className="overflow-hidden">
        {leads.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            {pending ? 'Загрузка…' : 'Ничего не найдено'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {leads.map((lead) => {
              const needs = needsDailyStatusUpdate(lead.statusConfirmedDate)
              const tone = lead.status ? LEAD_STATUS_TONE[lead.status] : null
              return (
                <li
                  key={lead.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 sm:px-5"
                >
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="truncate text-sm font-medium">
                      {lead.fullName || 'Без имени'}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[lead.vacancy, lead.phone].filter(Boolean).join(' · ') ||
                        '—'}
                    </p>
                  </div>

                  {lead.city ? (
                    <Badge
                      variant="outline"
                      className="gap-1 border-transparent bg-muted text-muted-foreground"
                    >
                      <MapPin className="size-3" />
                      {lead.city}
                    </Badge>
                  ) : null}

                  {lead.curatorName ? (
                    <span className="text-xs text-muted-foreground">
                      {lead.curatorName}
                    </span>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-transparent bg-destructive/15 text-destructive"
                    >
                      Без куратора
                    </Badge>
                  )}

                  {needs ? (
                    <Badge
                      variant="outline"
                      className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400"
                    >
                      Нужно обновить
                    </Badge>
                  ) : tone && lead.status ? (
                    <Badge
                      variant="outline"
                      className={cn('gap-1.5 border-transparent', tone.bg, tone.text)}
                    >
                      <span className={cn('size-1.5 rounded-full', tone.dot)} />
                      {leadStatusLabel(lead.status)}
                    </Badge>
                  ) : null}

                  {lead.transferredAt ? (
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(lead.transferredAt)}
                    </span>
                  ) : null}

                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Передать куратору"
                          disabled={pending}
                        >
                          <ArrowRightLeft className="size-4" />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end" className="min-w-52">
                      <DropdownMenuLabel>Передать куратору</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {curators.filter((c) => c.id !== lead.curatorId).length ===
                      0 ? (
                        <DropdownMenuItem disabled>
                          Нет доступных кураторов
                        </DropdownMenuItem>
                      ) : (
                        curators
                          .filter((c) => c.id !== lead.curatorId)
                          .map((c) => (
                            <DropdownMenuItem
                              key={c.id}
                              onClick={() => transfer(lead.id, c.id)}
                            >
                              <span className="truncate">{c.name}</span>
                              <span className="ml-auto text-xs text-muted-foreground">
                                {c.city ?? ''} · {c.activeLeads} лид.
                              </span>
                            </DropdownMenuItem>
                          ))
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <Button
            variant="outline"
            size="sm"
            disabled={pending || offset === 0}
            onClick={() => reload({ offset: Math.max(offset - PAGE_SIZE, 0) })}
          >
            Назад
          </Button>
          <span>
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} из {total}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || offset + PAGE_SIZE >= total}
            onClick={() => reload({ offset: offset + PAGE_SIZE })}
          >
            Вперёд
          </Button>
        </div>
      ) : null}
    </section>
  )
}
