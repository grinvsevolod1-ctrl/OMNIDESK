'use client'

/**
 * Строка/карточка лида менеджера по кадрам — визуально повторяет админскую
 * AdminLeadRow, но без передачи другому сотруднику и с «Архив» вместо
 * «Удалить». Мемоизирована: перерисовка списка не трогает строки с
 * неизменившимися данными. Два варианта отображения: компактная строка
 * (list) и небольшая карточка (grid).
 */

import { memo } from 'react'
import { Archive, ArchiveRestore, AtSign } from 'lucide-react'
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
  onRefresh,
}: {
  lead: LeadCard
  view: 'list' | 'grid'
  /** Строка рисуется во вкладке «Архив» — кнопка становится «Вернуть». */
  isArchived: boolean
  pending: boolean
  onOpen: (id: string) => void
  onToggleArchive: (id: string, archived: boolean) => void
  /** Перечитать список после inline-правки поля/статуса. */
  onRefresh: () => void
}) {
  const needs = !isArchived && leadNeedsDailyStatus(lead)

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
            {/* ФИО, должность, телефон правятся кликом — как у админа.
                stopPropagation живёт на самих контролах (см. lead-inline-edit),
                поэтому клик по пустому месту карточки открывает полную карточку. */}
            <TextInlineEditor
              lead={lead}
              field="full_name"
              label="ФИО"
              display={lead.fullName || 'Без имени'}
              className="text-sm font-medium"
              onSaved={onRefresh}
            />
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <TextInlineEditor
                lead={lead}
                field="vacancy"
                label="Должность"
                display={lead.vacancy}
                placeholder="Курьер, водитель…"
                onSaved={onRefresh}
              />
              <span aria-hidden>·</span>
              <TextInlineEditor
                lead={lead}
                field="phone"
                label="Телефон"
                display={lead.phone}
                placeholder="+7…"
                onSaved={onRefresh}
              />
            </div>
          </div>
          {archiveButton}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <CityInlineEditor lead={lead} onSaved={onRefresh} />
          {telegramLink}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          {statusEditor}
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
        {/* ФИО, должность, телефон правятся кликом — как у админа.
            stopPropagation живёт на самих контролах (см. lead-inline-edit),
            клик по пустому месту строки открывает полную карточку. */}
        <TextInlineEditor
          lead={lead}
          field="full_name"
          label="ФИО"
          display={lead.fullName || 'Без имени'}
          className="text-sm font-medium"
          onSaved={onRefresh}
        />
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <TextInlineEditor
            lead={lead}
            field="vacancy"
            label="Должность"
            display={lead.vacancy}
            placeholder="Курьер, водитель…"
            onSaved={onRefresh}
          />
          <span aria-hidden>·</span>
          <TextInlineEditor
            lead={lead}
            field="phone"
            label="Телефон"
            display={lead.phone}
            placeholder="+7…"
            onSaved={onRefresh}
          />
          {telegramLink}
        </div>
      </div>

      <span onClick={(e) => e.stopPropagation()} className="inline-flex">
        <CityInlineEditor lead={lead} onSaved={onRefresh} />
      </span>

      {statusEditor}

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
