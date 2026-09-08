'use client'

/**
 * Отчёт одного источника трафика для админа/руководителя. Открывается по клику
 * на карточку источника в «Обзоре» большим модальным окном на ~85% экрана.
 *
 * Показывает ТОЛЬКО поток лидов — никаких финансов/окон дня: сколько написали
 * и сколько передано куратору (за сегодня и всего). Плитки «Написали» и
 * «Передано» кликабельны — раскрывают список этих лидов (drill-down).
 * Данные тянутся клиентски (SWR) через getSourceLeadReportAction — скоуп по
 * роли проверяется на сервере (админ — любой источник, руководитель — только
 * байеры своей команды).
 */

import { useState } from 'react'
import useSWR from 'swr'
import {
  AtSign,
  Loader2,
  MapPin,
  MessageSquare,
  Phone,
  Send,
  Users,
} from 'lucide-react'
import {
  getSourceLeadReportAction,
  type SourceOverviewRow,
} from '@/app/actions/source-finance'
import { PlatformLogo } from '@/components/buyer/platform-logo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog'
import type { LeadCard } from '@/lib/data/lead-cards-core'
import { leadStatusLabel } from '@/lib/lead-status'
import { formatMskDateTime } from '@/lib/time'
import { platformOrCustom } from '@/lib/traffic-source-catalog'
import { cn } from '@/lib/utils'

type Segment = 'wrote' | 'transferred'

/**
 * Управляемая обёртка: рендерит модалку, когда выбран источник (row != null).
 */
export function SourceDetailDialog({
  row,
  onOpenChange,
}: {
  row: SourceOverviewRow | null
  onOpenChange: (open: boolean) => void
  /** Совместимость с вызывающими; отчёт read-only, ничего не меняет. */
  onChanged?: () => void
}) {
  return (
    <Dialog open={row !== null} onOpenChange={onOpenChange}>
      {row ? (
        <DialogContent
          showCloseButton={false}
          className="flex h-[85vh] max-h-[85vh] w-[85vw] max-w-[85vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[85vw]"
        >
          <SourceDetailBody row={row} />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

function SourceDetailBody({ row }: { row: SourceOverviewRow }) {
  const { source, stats } = row
  const platform = platformOrCustom(source.platformKey)
  const [segment, setSegment] = useState<Segment>('wrote')

  const { data, isLoading } = useSWR(
    ['source-lead-report', source.id],
    () => getSourceLeadReportAction(source.id),
    { keepPreviousData: true, revalidateOnFocus: false },
  )

  // Мгновенные числа из stats карточки, пока грузится подробный отчёт.
  const wroteToday = data?.wroteToday.length ?? stats?.todayTotal ?? 0
  const transferredToday =
    data?.transferredToday.length ?? stats?.transferredToday ?? 0
  const totalWrote = data?.totalWrote ?? stats?.total ?? 0
  const totalTransferred = data?.totalTransferred ?? stats?.transferredTotal ?? 0

  const leads =
    segment === 'wrote'
      ? (data?.wroteToday ?? [])
      : (data?.transferredToday ?? [])

  return (
    <>
      {/* Шапка: закреплена, не скроллится */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-card/60 px-5 py-4">
        <PlatformLogo platform={platform} size={52} rounded="rounded-xl" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{source.name}</h2>
            {!source.isActive ? (
              <Badge
                variant="outline"
                className="border-transparent bg-muted text-muted-foreground"
              >
                Выключен
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {platform.name}
            {source.externalAccount ? ` · ${source.externalAccount}` : ''} ·
            владелец: {source.buyerName ?? 'без владельца'}
          </p>
        </div>
        <DialogClose render={<Button variant="outline" size="sm" />}>
          Закрыть
        </DialogClose>
      </header>

      {/* Тело: скроллится */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="flex flex-col gap-5">
          {/* Плитки-переключатели: написали / передано (сегодня) + итоги */}
          <section
            aria-label="Отчёт за сегодня"
            className="grid grid-cols-2 gap-3 lg:grid-cols-4"
          >
            <ReportTile
              icon={MessageSquare}
              label="Написали сегодня"
              value={wroteToday}
              active={segment === 'wrote'}
              onClick={() => setSegment('wrote')}
              tone="primary"
            />
            <ReportTile
              icon={Send}
              label="Передано сегодня"
              value={transferredToday}
              active={segment === 'transferred'}
              onClick={() => setSegment('transferred')}
              tone="success"
            />
            <ReportTile
              icon={Users}
              label="Всего написали"
              value={totalWrote}
            />
            <ReportTile
              icon={Send}
              label="Всего передано"
              value={totalTransferred}
            />
          </section>

          {/* Drill-down: список лидов выбранного среза */}
          <Card className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                {segment === 'wrote'
                  ? 'Написали сегодня'
                  : 'Передано куратору сегодня'}
              </h3>
              <span className="text-xs text-muted-foreground">
                {leads.length} лид(ов)
              </span>
            </div>

            {isLoading && !data ? (
              <div className="flex h-40 items-center justify-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
                <span className="sr-only">Загрузка отчёта источника</span>
              </div>
            ) : leads.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
                {segment === 'wrote'
                  ? 'Сегодня по этому источнику ещё никто не написал.'
                  : 'Сегодня по этому источнику ещё нет передач куратору.'}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {leads.map((lead) => (
                  <LeadRow key={lead.id} lead={lead} segment={segment} />
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  )
}

/* ------------------------------ Плитка ------------------------------ */

function ReportTile({
  icon: Icon,
  label,
  value,
  active,
  onClick,
  tone = 'default',
}: {
  icon: typeof MessageSquare
  label: string
  value: number
  active?: boolean
  onClick?: () => void
  tone?: 'default' | 'primary' | 'success'
}) {
  const toneCls = {
    default: 'text-foreground',
    primary: 'text-primary',
    success: 'text-success',
  }[tone]
  const interactive = typeof onClick === 'function'
  return (
    <Card
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
      className={cn(
        'flex flex-col gap-1 p-4 transition-colors',
        interactive &&
          'cursor-pointer hover:border-foreground/30 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active && 'border-primary bg-primary/5',
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className={cn('size-3.5', tone === 'default' ? '' : toneCls)} />
        {label}
      </span>
      <span className={cn('text-2xl font-semibold tabular-nums', toneCls)}>
        {value}
      </span>
      {interactive ? (
        <span className="text-[11px] text-muted-foreground">
          {active ? 'Показан ниже' : 'Нажмите, чтобы раскрыть'}
        </span>
      ) : null}
    </Card>
  )
}

/* ------------------------------ Строка лида ------------------------------ */

/** Контакт лида: @username → телефон → Telegram ID → «—». */
function leadContact(lead: LeadCard): { icon: typeof AtSign; text: string } {
  if (lead.telegramUsername) {
    return { icon: AtSign, text: lead.telegramUsername.replace(/^@/, '') }
  }
  if (lead.phone) return { icon: Phone, text: lead.phone }
  if (lead.telegramId) return { icon: AtSign, text: lead.telegramId }
  return { icon: AtSign, text: '—' }
}

function LeadRow({ lead, segment }: { lead: LeadCard; segment: Segment }) {
  const contact = leadContact(lead)
  const ContactIcon = contact.icon
  const when =
    segment === 'transferred' ? lead.transferredAt : lead.createdAt
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-background/40 px-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {lead.fullName || 'Без имени'}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <ContactIcon className="size-3" />
            {contact.text}
          </span>
          {lead.city ? (
            <span className="flex items-center gap-1">
              <MapPin className="size-3" />
              {lead.city}
            </span>
          ) : null}
          {lead.curatorName && segment === 'transferred' ? (
            <span className="flex items-center gap-1">
              <Send className="size-3" />
              {lead.curatorName}
            </span>
          ) : null}
        </span>
      </span>
      {lead.status ? (
        <Badge variant="outline" className="shrink-0 text-xs">
          {leadStatusLabel(lead.status)}
        </Badge>
      ) : null}
      {when ? (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatMskDateTime(when)}
        </span>
      ) : null}
    </li>
  )
}
