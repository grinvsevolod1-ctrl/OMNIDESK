'use client'

import { memo } from 'react'
import { MapPin, MessageSquare } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { ManagerLeadListItem } from '@/lib/data/lead-stats'
import { LEAD_STATUS_TONE, leadStatusLabel } from '@/lib/lead-status'
import { formatMskDateTime as formatDateTime } from '@/lib/time'
import { cn } from '@/lib/utils'

/**
 * Строка лида в списке менеджера. memo: фоновый пуллинг каждые 5с обновляет
 * массив лидов — перерисовываются только строки с изменившимися данными.
 * onOpen должен быть стабильным (useCallback в контейнере).
 *
 * Раскладка — CSS grid с фиксированными колонками (имя · комментарии ·
 * город · передан · статус · дата), как у админской и кураторской таблиц:
 * во всех строках колонки выровнены по одной сетке, бейджи не «плавают»
 * и не наезжают друг на друга (overflow-hidden + truncate в каждой ячейке).
 * Ниже брейкпоинтов второстепенные колонки скрываются целиком.
 */
export const ManagerLeadRow = memo(function ManagerLeadRow({
  lead,
  isFresh,
  showTransferredDate,
  onOpen,
}: {
  lead: ManagerLeadListItem
  /** Лид появился при фоновом обновлении — подсветить. */
  isFresh: boolean
  /** Показывать дату передачи вместо даты создания. */
  showTransferredDate: boolean
  onOpen: (leadId: string) => void
}) {
  const tone = lead.status ? LEAD_STATUS_TONE[lead.status] : null
  return (
    <li
      className={cn(
        'grid cursor-pointer items-center gap-x-3 px-4 py-3 transition-colors duration-1000 hover:bg-muted/40 sm:px-5',
        // Колонки: имя · [комментарии] · [город] · [передан] · статус · дата.
        'grid-cols-[minmax(0,1fr)_minmax(0,9.5rem)]',
        'sm:grid-cols-[minmax(0,1fr)_minmax(0,9.5rem)_8.5rem]',
        'md:grid-cols-[minmax(0,1fr)_minmax(0,11.5rem)_minmax(0,9.5rem)_8.5rem]',
        'lg:grid-cols-[minmax(0,1fr)_2.5rem_minmax(0,9rem)_minmax(0,11.5rem)_minmax(0,9.5rem)_8.5rem]',
        // Строки за экраном не рендерятся при скролле (стандарт UI, AGENTS.md).
        '[content-visibility:auto] [contain-intrinsic-size:auto_3.75rem]',
        isFresh &&
          'bg-primary/10 duration-150 animate-in fade-in slide-in-from-top-2',
      )}
      onClick={() => onOpen(lead.id)}
    >
      <button
        type="button"
        className="min-w-0 text-left"
        onClick={() => onOpen(lead.id)}
        aria-label={`Открыть карточку: ${lead.fullName || 'Без имени'}`}
      >
        <p className="truncate text-sm font-medium">
          {lead.fullName || 'Без имени'}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {[lead.vacancy, lead.phone].filter(Boolean).join(' · ') || '—'}
        </p>
      </button>

      {/* Комментарии сотрудника — узкая колонка, рендерится всегда (lg+). */}
      <span className="hidden min-w-0 lg:inline-flex">
        {lead.curatorCommentCount > 0 ? (
          <Badge
            variant="outline"
            className="gap-1 border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400"
          >
            <MessageSquare className="size-3" />
            {lead.curatorCommentCount}
          </Badge>
        ) : null}
      </span>

      {/* Город — ячейка с overflow-hidden: длинные названия обрезаются,
          не наезжая на соседние колонки. */}
      <span className="hidden min-w-0 overflow-hidden lg:inline-flex">
        {lead.city ? (
          <Badge
            variant="outline"
            className="max-w-full gap-1 border-transparent bg-muted text-muted-foreground"
          >
            <MapPin className="size-3 shrink-0" />
            <span className="truncate">{lead.city}</span>
          </Badge>
        ) : null}
      </span>

      {/* Передан кому / не передан. */}
      <span className="hidden min-w-0 overflow-hidden md:inline-flex">
        {lead.transferredAt ? (
          <Badge
            variant="outline"
            className="max-w-full border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
          >
            <span className="truncate">
              Передан{lead.curatorName ? `: ${lead.curatorName}` : ''}
            </span>
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="border-transparent bg-muted text-muted-foreground"
          >
            Не передан
          </Badge>
        )}
      </span>

      {/* Статус — левые края бейджей выровнены по колонке. */}
      <span className="min-w-0 overflow-hidden">
        {tone && lead.status ? (
          <div className="flex min-w-0 flex-col items-start gap-0.5">
            <Badge
              variant="outline"
              className={cn(
                'max-w-full gap-1.5 border-transparent',
                tone.bg,
                tone.text,
              )}
            >
              <span
                className={cn('size-1.5 shrink-0 rounded-full', tone.dot)}
              />
              <span className="truncate">{leadStatusLabel(lead.status)}</span>
            </Badge>
            {lead.statusConfirmedAt ? (
              <time
                dateTime={lead.statusConfirmedAt}
                className="whitespace-nowrap text-[11px] leading-none tabular-nums text-muted-foreground"
              >
                {formatDateTime(lead.statusConfirmedAt)}
              </time>
            ) : null}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </span>

      {/* Дата — табличные цифры, выровнена по правому краю. */}
      <span className="hidden justify-self-end text-right text-xs tabular-nums text-muted-foreground sm:block">
        {formatDateTime(
          lead.transferredAt && showTransferredDate
            ? lead.transferredAt
            : lead.createdAt,
        )}
      </span>
    </li>
  )
})
