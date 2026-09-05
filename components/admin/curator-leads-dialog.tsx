'use client'

import { useEffect, useState, useTransition } from 'react'
import useSWR from 'swr'
import {
  ArrowRightLeft,
  Loader2,
  MapPin,
  MoreHorizontal,
  User,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  getLeadCardDetailAction,
  listActiveCuratorsAction,
  listCuratorLeadsAdminAction,
  transferLeadAdminAction,
} from '@/app/actions/lead-cards'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type {
  CuratorWithLoad,
  LeadCard,
  LeadCardComment,
} from '@/lib/data/lead-cards'
import {
  LEAD_STATUS_TONE,
  leadStatusLabel,
  leadNeedsDailyStatus,
  type LeadStatus,
} from '@/lib/lead-status'
import { formatMskDateTimeFull as formatDateTime } from '@/lib/time'
import type { Manager } from '@/lib/types'
import { cn } from '@/lib/utils'

function StatusAssignedAt({ at }: { at: string }) {
  return (
    <time
      dateTime={at}
      className="whitespace-nowrap text-[11px] leading-none tabular-nums text-muted-foreground"
    >
      {formatDateTime(at)}
    </time>
  )
}

function StatusBadge({
  status,
  needsUpdate,
  previousStatus,
  at,
}: {
  status: LeadStatus | null
  needsUpdate: boolean
  previousStatus: LeadStatus | null
  at?: string | null
}) {
  if (needsUpdate) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge
          variant="outline"
          className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400"
        >
          Нужно обновить
        </Badge>
        {previousStatus ? (
          <span className="text-[11px] text-muted-foreground">
            вчера: {leadStatusLabel(previousStatus)}
          </span>
        ) : null}
        {at ? <StatusAssignedAt at={at} /> : null}
      </div>
    )
  }
  if (!status) {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <Badge
          variant="outline"
          className="border-transparent bg-muted text-muted-foreground"
        >
          Не указан
        </Badge>
        {at ? <StatusAssignedAt at={at} /> : null}
      </span>
    )
  }
  const tone = LEAD_STATUS_TONE[status]
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <Badge
        variant="outline"
        className={cn('gap-1.5 border-transparent', tone.bg, tone.text)}
      >
        <span className={cn('size-1.5 rounded-full', tone.dot)} />
        {leadStatusLabel(status)}
      </Badge>
      {at ? <StatusAssignedAt at={at} /> : null}
    </span>
  )
}

export function CuratorLeadsDialog({
  curator,
  open,
  onOpenChange,
}: {
  curator: Manager
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Reset selection when the dialog is (re)opened — adjustment during render.
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    setSelectedId(null)
  }

  const {
    data: listData,
    isLoading: loading,
    mutate: reloadList,
  } = useSWR(
    open ? ['curator-leads-admin', curator.id] : null,
    async () => {
      const [list, all] = await Promise.all([
        listCuratorLeadsAdminAction(curator.id),
        listActiveCuratorsAction(),
      ])
      return { list, all: all.filter((c) => c.id !== curator.id) }
    },
    { revalidateOnFocus: false },
  )
  const leads: LeadCard[] = listData?.list ?? []
  const curators: CuratorWithLoad[] = listData?.all ?? []

  const { data: detailData, isLoading: detailLoading } = useSWR(
    open && selectedId ? ['lead-detail-admin', selectedId] : null,
    () => getLeadCardDetailAction(selectedId as string),
    { revalidateOnFocus: false },
  )
  const detail: { card: LeadCard; comments: LeadCardComment[] } | null =
    selectedId && detailData ? detailData : null

  // Escape closes the modal (custom overlay, so no built-in dialog handling).
  // On mobile the detail view sits on top of the list, so a first Escape steps
  // back to the list and a second one closes the whole modal.
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (selectedId) {
        setSelectedId(null)
      } else {
        onOpenChange(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, selectedId, onOpenChange])

  function transfer(leadId: string, toCuratorId: string) {
    startTransition(async () => {
      const res = await transferLeadAdminAction({
        leadCardId: leadId,
        curatorId: toCuratorId,
      })
      if (res.ok) {
        toast.success(res.message)
        setSelectedId(null)
        void reloadList()
      } else {
        toast.error(res.message)
      }
    })
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/40 supports-backdrop-filter:backdrop-blur-sm"
        aria-label="Закрыть"
        onClick={() => onOpenChange(false)}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Лиды менеджера по кадрам ${curator.name}`}
        className={cn(
          'relative z-10 flex w-[min(96vw,72rem)] flex-col overflow-hidden rounded-2xl bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/10',
          'h-[min(92dvh,56rem)] animate-in fade-in-0 zoom-in-95 duration-200',
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-6">
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold tracking-tight">
              {curator.name}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              {curator.city ? (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="size-3" />
                  {curator.city}
                </span>
              ) : null}
              <span>{curator.email}</span>
              <span>· {leads.length} лидов</span>
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onOpenChange(false)}
            aria-label="Закрыть"
          >
            <X className="size-4" />
          </Button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* List */}
          <div
            className={cn(
              'min-h-0 overflow-y-auto border-border md:w-[42%] md:border-r',
              selectedId ? 'hidden md:block' : 'flex-1',
            )}
          >
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Загрузка…
              </div>
            ) : leads.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-muted-foreground">
                <User className="size-8 opacity-40" />
                <p className="text-sm">У менеджера по кадрам пока нет лидов</p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {leads.map((lead) => {
                  const needs = leadNeedsDailyStatus(lead)
                  return (
                    <li key={lead.id}>
                      <div
                        className={cn(
                          'flex items-start gap-2 px-4 py-3 transition-colors sm:px-5',
                          selectedId === lead.id
                            ? 'bg-primary/8'
                            : 'hover:bg-muted/40',
                        )}
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => setSelectedId(lead.id)}
                        >
                          <p className="truncate font-medium">
                            {lead.fullName || 'Без имени'}
                          </p>
                          {lead.vacancy ? (
                            <p className="truncate text-xs text-muted-foreground">
                              {lead.vacancy}
                            </p>
                          ) : null}
                          <div className="mt-1.5">
              <StatusBadge
                status={lead.status}
                needsUpdate={needs}
                previousStatus={lead.previousStatus}
                at={lead.statusConfirmedAt}
              />
                          </div>
                        </button>

                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="Действия"
                                disabled={pending}
                              >
                                <MoreHorizontal className="size-4" />
                              </Button>
                            }
                          />
                          <DropdownMenuContent align="end" className="min-w-52">
                            <DropdownMenuLabel>
                              Передать другому менеджеру по кадрам
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {curators.length === 0 ? (
                              <DropdownMenuItem disabled>
                                Нет других менеджеров по кадрам
                              </DropdownMenuItem>
                            ) : (
                              curators.map((c) => (
                                <DropdownMenuItem
                                  key={c.id}
                                  onClick={() => transfer(lead.id, c.id)}
                                >
                                  <ArrowRightLeft className="size-3.5" />
                                  <span className="truncate">{c.name}</span>
                                  {c.cities?.length || c.city ? (
                                    <span className="ml-auto max-w-[45%] truncate text-xs text-muted-foreground">
                                      {c.cities?.length
                                        ? c.cities.join(', ')
                                        : c.city}
                                    </span>
                                  ) : null}
                                </DropdownMenuItem>
                              ))
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {/* Detail */}
          <div
            className={cn(
              'min-h-0 flex-1 overflow-y-auto',
              !selectedId ? 'hidden md:flex md:items-center md:justify-center' : '',
            )}
          >
            {!selectedId ? (
              <p className="px-6 text-sm text-muted-foreground">
                Выберите лид, чтобы увидеть детали
              </p>
            ) : detailLoading || !detail ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Загрузка…
              </div>
            ) : (
              <div className="flex flex-col gap-5 p-4 sm:p-6">
                <div className="flex items-start justify-between gap-2 md:hidden">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedId(null)}
                  >
                    ← К списку
                  </Button>
                </div>

                <div>
                  <h2 className="text-xl font-semibold tracking-tight">
                    {detail.card.fullName || 'Без имени'}
                  </h2>
                  {detail.card.vacancy ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {detail.card.vacancy}
                    </p>
                  ) : null}
                  <div className="mt-3">
              <StatusBadge
                status={detail.card.status}
                needsUpdate={leadNeedsDailyStatus(detail.card)}
                previousStatus={detail.card.previousStatus}
                at={detail.card.statusConfirmedAt}
              />
                  </div>
                </div>

                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  {detail.card.phone ? (
                    <div>
                      <dt className="text-xs text-muted-foreground">Телефон</dt>
                      <dd className="font-medium">{detail.card.phone}</dd>
                    </div>
                  ) : null}
                  {detail.card.telegramUsername ? (
                    <div>
                      <dt className="text-xs text-muted-foreground">Telegram</dt>
                      <dd className="font-medium">
                        @{detail.card.telegramUsername}
                      </dd>
                    </div>
                  ) : null}
                  {detail.card.city ? (
                    <div>
                      <dt className="text-xs text-muted-foreground">Город</dt>
                      <dd className="font-medium">{detail.card.city}</dd>
                    </div>
                  ) : null}
                  {detail.card.address ? (
                    <div className="sm:col-span-2">
                      <dt className="text-xs text-muted-foreground">Адрес</dt>
                      <dd className="font-medium">{detail.card.address}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt className="text-xs text-muted-foreground">Менеджер</dt>
                    <dd className="font-medium">
                      {detail.card.managerName ?? '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Передан</dt>
                    <dd className="font-medium">
                      {detail.card.transferredAt
                        ? formatDateTime(detail.card.transferredAt)
                        : '—'}
                    </dd>
                  </div>
                </dl>

                <section>
                  <h3 className="mb-2 text-sm font-semibold">Комментарии</h3>
                  {detail.comments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Пока нет комментариев
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2.5">
                      {detail.comments.map((c) => (
                        <li
                          key={c.id}
                          className="rounded-lg border border-border bg-muted/30 px-3 py-2.5"
                        >
                          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">
                              {c.authorName ?? 'Менеджер по кадрам'}
                            </span>
                            {c.status ? (
                              <Badge
                                variant="outline"
                                className="border-transparent bg-background text-[10px]"
                              >
                                {leadStatusLabel(c.status)}
                              </Badge>
                            ) : null}
                            <span className="ml-auto">
                              {formatDateTime(c.createdAt)}
                            </span>
                          </div>
                          <p className="whitespace-pre-wrap text-sm leading-relaxed">
                            {c.body}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
