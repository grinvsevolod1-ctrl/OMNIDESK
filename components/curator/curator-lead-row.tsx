'use client'

/**
 * Строка/карточка лида менеджера по кадрам — визуально повторяет админскую
 * AdminLeadRow, но без передачи другому сотруднику и с «Архив» вместо
 * «Удалить». Мемоизирована: перерисовка списка не трогает строки с
 * неизменившимися данными. Два варианта отображения: компактная строка
 * (list) и небольшая карточка (grid).
 */

import { memo } from 'react'
import { Archive, ArchiveRestore, AtSign, MapPin } from 'lucide-react'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { LeadCard } from '@/lib/data/lead-cards'
import { leadNeedsDailyStatus } from '@/lib/lead-status'
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

export const CuratorLeadRow = memo(function CuratorLeadRow({
  lead,
  view,
  isArchived,
  pending,
  onOpen,
  onToggleArchive,
}: {
  lead: LeadCard
  view: 'list' | 'grid'
  /** Строка рисуется во вкладке «Архив» — кнопка становится «Вернуть». */
  isArchived: boolean
  pending: boolean
  onOpen: (id: string) => void
  onToggleArchive: (id: string, archived: boolean) => void
}) {
  const needs = !isArchived && leadNeedsDailyStatus(lead)

  const archiveButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={pending}
            aria-label={isArchived ? 'Вернуть из архива' : 'В архив'}
            onClick={(e) => {
              e.stopPropagation()
              onToggleArchive(lead.id, !isArchived)
            }}
          >
            {isArchived ? (
              <ArchiveRestore className="size-4" />
            ) : (
              <Archive className="size-4" />
            )}
          </Button>
        }
      />
      <TooltipContent side="top">
        {isArchived ? 'Вернуть из архива' : 'В архив'}
      </TooltipContent>
    </Tooltip>
  )

  const telegramLink = lead.telegramUsername ? (
    <a
      href={`https://t.me/${lead.telegramUsername}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 text-primary transition-opacity hover:opacity-75"
      title="Открыть чат в Telegram"
      onClick={(e) => e.stopPropagation()}
    >
      <AtSign className="size-3" />
      {lead.telegramUsername}
    </a>
  ) : null

  if (view === 'grid') {
    return (
      <li
        className={cn(
          'group flex cursor-pointer flex-col gap-2 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-muted/30',
          needs && 'ring-1 ring-amber-500/30',
          isArchived && 'opacity-70 hover:opacity-100',
        )}
        onClick={() => onOpen(lead.id)}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {lead.fullName || 'Без имени'}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {[lead.vacancy, lead.phone].filter(Boolean).join(' · ') || '—'}
            </p>
          </div>
          {archiveButton}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {lead.city ? (
            <Badge
              variant="outline"
              className="gap-1 border-transparent bg-muted text-muted-foreground"
            >
              <MapPin className="size-3" />
              {lead.city}
            </Badge>
          ) : null}
          {telegramLink}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          <LeadStatusBadge
            status={lead.status}
            needsUpdate={needs}
            previousStatus={lead.previousStatus}
          />
          <span className="ml-auto text-xs text-muted-foreground">
            {isArchived && lead.archivedAt
              ? formatDateTime(lead.archivedAt)
              : lead.transferredAt
                ? formatDateTime(lead.transferredAt)
                : ''}
          </span>
        </div>
      </li>
    )
  }

  return (
    <li
      className={cn(
        'flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 transition-colors hover:bg-muted/30 sm:px-5',
        needs && 'bg-amber-500/[0.04]',
        isArchived && 'opacity-70 hover:opacity-100',
      )}
      onClick={() => onOpen(lead.id)}
    >
      <div className="min-w-0 flex-1 basis-44">
        <p className="truncate text-sm font-medium">
          {lead.fullName || 'Без имени'}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {lead.vacancy ? <span className="truncate">{lead.vacancy}</span> : null}
          {lead.vacancy && lead.phone ? <span aria-hidden>·</span> : null}
          {lead.phone ? <span>{lead.phone}</span> : null}
          {telegramLink}
        </div>
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

      <LeadStatusBadge
        status={lead.status}
        needsUpdate={needs}
        previousStatus={lead.previousStatus}
      />

      {isArchived && lead.archivedAt ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="cursor-default text-xs text-muted-foreground">
                {formatDateTime(lead.archivedAt)}
              </span>
            }
          />
          <TooltipContent side="top">В архиве с</TooltipContent>
        </Tooltip>
      ) : lead.transferredAt ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="cursor-default text-xs text-muted-foreground">
                {formatDateTime(lead.transferredAt)}
              </span>
            }
          />
          <TooltipContent side="top">Дата передачи</TooltipContent>
        </Tooltip>
      ) : null}

      {archiveButton}
    </li>
  )
})
