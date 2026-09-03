'use client'

/**
 * Строка/карточка лида менеджера по кадрам — визуально повторяет админскую
 * AdminLeadRow, но без передачи другому сотруднику и с «Архив» вместо
 * «Удалить». Мемоизирована: перерисовка списка не трогает строки с
 * неизменившимися данными. Два варианта отображения: компактная строка
 * (list) и небольшая карточка (grid).
 *
 * ПУЛОВЫЙ лид (isPool, миграция 150) — ещё не взят: он не закреплён за
 * куратором, поэтому редактировать/открывать его нельзя (нет доступа). Такая
 * строка показывается read-only с бейджем «в пуле» и кнопкой «Взять в работу»
 * (claim). После взятия строка становится обычной, редактируемой.
 */

import { memo } from 'react'
import { Archive, ArchiveRestore, AtSign, MapPin, Sparkles } from 'lucide-react'
import {
  CityInlineEditor,
  StatusInlineEditor,
  TextInlineEditor,
} from '@/components/admin/lead-inline-edit'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { LeadCard } from '@/lib/data/lead-cards'
import { leadNeedsDailyStatus } from '@/lib/lead-status'
import { formatMskDateTime as formatDateTime } from '@/lib/time'
import { cn } from '@/lib/utils'

export const CuratorLeadRow = memo(function CuratorLeadRow({
  lead,
  view,
  isArchived,
  pending,
  onOpen,
  onToggleArchive,
  onClaim,
  onRefresh,
}: {
  lead: LeadCard
  view: 'list' | 'grid'
  /** Строка рисуется во вкладке «Архив» — кнопка становится «Вернуть». */
  isArchived: boolean
  pending: boolean
  onOpen: (id: string) => void
  onToggleArchive: (id: string, archived: boolean) => void
  /** Взять пуловый лид в работу (claim). */
  onClaim: (id: string) => void
  /** Перечитать список после inline-правки поля/статуса. */
  onRefresh: () => void
}) {
  const isPool = lead.isPool && !isArchived
  const needs = !isArchived && !isPool && leadNeedsDailyStatus(lead)

  /** Кликабельный бейдж статуса: сохраняет подсветку «нужно обновить». */
  const statusEditor = (
    <span onClick={(e) => e.stopPropagation()} className="inline-flex">
      <StatusInlineEditor
        lead={lead}
        variant="curator"
        onSaved={onRefresh}
        trigger={
          <button
            type="button"
            className="inline-flex cursor-pointer"
            aria-label="Изменить статус"
          >
            <LeadStatusBadge
              status={lead.status}
              needsUpdate={needs}
              previousStatus={lead.previousStatus}
            />
          </button>
        }
      />
    </span>
  )

  /** Бейдж «в пуле» — пуловый лид ещё не закреплён. */
  const poolBadge = (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
      <Sparkles className="size-3" />В пуле
    </span>
  )

  /** Кнопка «Взять в работу» для пулового лида (полная — в карточках). */
  const claimButton = (
    <Button
      size="sm"
      className="h-7 shrink-0 gap-1 bg-emerald-600 px-2.5 text-white hover:bg-emerald-600/90"
      disabled={pending}
      aria-label="Взять в работу"
      onClick={(e) => {
        e.stopPropagation()
        onClaim(lead.id)
      }}
    >
      <Sparkles className="size-3.5" />
      Взять
    </Button>
  )

  /** Иконка-кнопка «Взять» — в узкой колонке действий списка. */
  const claimButtonIcon = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            className="bg-emerald-600 text-white hover:bg-emerald-600/90"
            disabled={pending}
            aria-label="Взять в работу"
            onClick={(e) => {
              e.stopPropagation()
              onClaim(lead.id)
            }}
          >
            <Sparkles className="size-4" />
          </Button>
        }
      />
      <TooltipContent side="top">Взять в работу</TooltipContent>
    </Tooltip>
  )

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

  // Read-only отображение имени/должности/телефона для пула (без inline-правки).
  const nameNode = isPool ? (
    <p className="truncate text-sm font-medium">{lead.fullName || 'Без имени'}</p>
  ) : (
    <TextInlineEditor
      lead={lead}
      field="full_name"
      label="ФИО"
      display={lead.fullName || 'Без имени'}
      className="text-sm font-medium"
      onSaved={onRefresh}
    />
  )
  const vacancyNode = isPool ? (
    <span>{lead.vacancy || '—'}</span>
  ) : (
    <TextInlineEditor
      lead={lead}
      field="vacancy"
      label="Должность"
      display={lead.vacancy}
      placeholder="Курьер, водитель…"
      onSaved={onRefresh}
    />
  )
  const phoneNode = isPool ? (
    <span>{lead.phone || '—'}</span>
  ) : (
    <TextInlineEditor
      lead={lead}
      field="phone"
      label="Телефон"
      display={lead.phone}
      placeholder="+7…"
      onSaved={onRefresh}
    />
  )
  const cityNode = isPool ? (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <MapPin className="size-3 shrink-0" />
      {lead.city || '—'}
    </span>
  ) : (
    <CityInlineEditor lead={lead} onSaved={onRefresh} />
  )

  if (view === 'grid') {
    return (
      <li
        className={cn(
          'group flex flex-col gap-2 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-muted/30',
          '[content-visibility:auto] [contain-intrinsic-size:auto_9rem]',
          needs && 'ring-1 ring-amber-500/30',
          isPool && 'cursor-default border-emerald-500/30 bg-emerald-500/[0.04]',
          !isPool && 'cursor-pointer',
          isArchived && 'opacity-70 hover:opacity-100',
        )}
        onClick={isPool ? undefined : () => onOpen(lead.id)}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {nameNode}
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              {vacancyNode}
              <span aria-hidden>·</span>
              {phoneNode}
            </div>
          </div>
          {isPool ? claimButton : archiveButton}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {cityNode}
          {telegramLink}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          {isPool ? poolBadge : statusEditor}
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
        // CSS grid с фиксированными колонками (имя · город · статус · дата ·
        // действие) — во всех строках колонки выровнены по одной сетке.
        'grid grid-cols-[minmax(0,1fr)_max-content_2.25rem] items-center gap-x-3 px-4 py-2.5 transition-colors hover:bg-muted/30 sm:px-5',
        'sm:grid-cols-[minmax(0,1fr)_7.5rem_max-content_2.25rem]',
        'lg:grid-cols-[minmax(0,1fr)_7.5rem_minmax(7rem,max-content)_8.5rem_2.25rem]',
        '[content-visibility:auto] [contain-intrinsic-size:auto_3.5rem]',
        needs && 'bg-amber-500/[0.04]',
        isPool && 'cursor-default bg-emerald-500/[0.04]',
        !isPool && 'cursor-pointer',
        isArchived && 'opacity-70 hover:opacity-100',
      )}
      onClick={isPool ? undefined : () => onOpen(lead.id)}
    >
      <div className="min-w-0">
        {nameNode}
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {vacancyNode}
          <span aria-hidden>·</span>
          {phoneNode}
          {telegramLink}
        </div>
      </div>

      <span
        onClick={(e) => e.stopPropagation()}
        className="hidden min-w-0 overflow-hidden sm:inline-flex"
      >
        {cityNode}
      </span>

      {isPool ? (
        <span className="inline-flex">{poolBadge}</span>
      ) : (
        statusEditor
      )}

      {/* Ячейка даты рендерится всегда (lg+) — иначе сетка сломается. */}
      <span className="hidden min-w-0 lg:block">
        {isArchived && lead.archivedAt ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="cursor-default text-xs tabular-nums text-muted-foreground">
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
                <span className="cursor-default text-xs tabular-nums text-muted-foreground">
                  {formatDateTime(lead.transferredAt)}
                </span>
              }
            />
            <TooltipContent side="top">
              {isPool ? 'В пуле с' : 'Дата передачи'}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </span>

      {isPool ? claimButtonIcon : archiveButton}
    </li>
  )
})
