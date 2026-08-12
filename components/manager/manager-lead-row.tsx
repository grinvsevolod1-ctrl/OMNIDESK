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
        'flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 transition-colors duration-1000 hover:bg-muted/40 sm:px-5',
        isFresh &&
          'bg-primary/10 duration-150 animate-in fade-in slide-in-from-top-2',
      )}
    >
      <button
        type="button"
        className="min-w-0 flex-1 basis-48 text-left"
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

      {lead.curatorCommentCount > 0 ? (
        <Badge
          variant="outline"
          className="gap-1 border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400"
        >
          <MessageSquare className="size-3" />
          {lead.curatorCommentCount}
        </Badge>
      ) : null}

      {lead.city ? (
        <Badge
          variant="outline"
          className="gap-1 border-transparent bg-muted text-muted-foreground"
        >
          <MapPin className="size-3" />
          {lead.city}
        </Badge>
      ) : null}

      {lead.transferredAt ? (
        <Badge
          variant="outline"
          className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
        >
          Передан{lead.curatorName ? `: ${lead.curatorName}` : ''}
        </Badge>
      ) : (
        <Badge
          variant="outline"
          className="border-transparent bg-muted text-muted-foreground"
        >
          Не передан
        </Badge>
      )}

      {tone && lead.status ? (
        <Badge
          variant="outline"
          className={cn('gap-1.5 border-transparent', tone.bg, tone.text)}
        >
          <span className={cn('size-1.5 rounded-full', tone.dot)} />
          {leadStatusLabel(lead.status)}
        </Badge>
      ) : null}

      <span className="text-xs text-muted-foreground">
        {formatDateTime(
          lead.transferredAt && showTransferredDate
            ? lead.transferredAt
            : lead.createdAt,
        )}
      </span>
    </li>
  )
})
