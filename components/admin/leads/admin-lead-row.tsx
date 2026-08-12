'use client'

import { memo } from 'react'
import { ArrowRightLeft, AtSign } from 'lucide-react'
import {
  CityInlineEditor,
  DeleteLeadButton,
  StatusInlineEditor,
  TextInlineEditor,
} from '@/components/admin/lead-inline-edit'
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { CuratorWithLoad, LeadCard } from '@/lib/data/lead-cards'
import { leadNeedsDailyStatus } from '@/lib/lead-status'
import { formatMskDateTime as formatDateTime } from '@/lib/time'
import { cn } from '@/lib/utils'

/**
 * Одна строка лида в админ-таблице. Обёрнута в memo: фоновый пуллинг каждые
 * 5с вызывает setLeads — без мемоизации перерисовывались бы все ~20 строк
 * страницы; с memo перерисовываются только строки с изменившимися данными.
 * Важно: пропсы-колбэки (onRefresh/onTransfer) должны быть стабильными
 * (useCallback в контейнере), иначе memo бесполезен.
 */
export const AdminLeadRow = memo(function AdminLeadRow({
  lead,
  curators,
  isFresh,
  pending,
  onRefresh,
  onTransfer,
  onOpen,
}: {
  lead: LeadCard
  curators: CuratorWithLoad[]
  /** Лид появился при фоновом обновлении — подсветить. */
  isFresh: boolean
  pending: boolean
  onRefresh: () => void
  onTransfer: (leadId: string, toCuratorId: string) => void
  /** Клик по свободному месту строки — открыть полную карточку лида. */
  onOpen?: (leadId: string) => void
}) {
  const needs = leadNeedsDailyStatus(lead)
  return (
    <li
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 transition-colors duration-1000 sm:px-5',
        // Новый лид, появившийся при фоновом обновлении, —
        // плавная подсветка на несколько секунд.
        isFresh &&
          'bg-primary/10 duration-150 animate-in fade-in slide-in-from-top-2',
        // Свободное место строки открывает полную карточку; интерактивные
        // элементы внутри гасят всплытие через stopPropagation.
        onOpen && 'cursor-pointer hover:bg-muted/40',
      )}
      onClick={onOpen ? () => onOpen(lead.id) : undefined}
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.key === 'Enter' && e.target === e.currentTarget) {
                onOpen(lead.id)
              }
            }
          : undefined
      }
      tabIndex={onOpen ? 0 : undefined}
      aria-label={onOpen ? 'Открыть карточку лида' : undefined}
    >
      <div
        className="min-w-0 flex-1 basis-48"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ФИО, должность, телефон редактируются кликом по значению */}
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
          {lead.telegramUsername ? (
            <a
              href={`https://t.me/${lead.telegramUsername}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-primary transition-opacity hover:opacity-75"
              title="Открыть чат в Telegram"
            >
              <AtSign className="size-3" />
              {lead.telegramUsername}
            </a>
          ) : null}
        </div>
      </div>

      <span onClick={(e) => e.stopPropagation()} className="inline-flex">
        <CityInlineEditor lead={lead} onSaved={onRefresh} />
      </span>

      {lead.curatorName ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="cursor-default text-xs text-muted-foreground">
                {lead.curatorName}
              </span>
            }
          />
          <TooltipContent side="top">Менеджер по кадрам</TooltipContent>
        </Tooltip>
      ) : (
        <Badge
          variant="outline"
          className="border-transparent bg-destructive/15 text-destructive"
        >
          Без менеджера по кадрам
        </Badge>
      )}

      {needs ? (
        <Badge
          variant="outline"
          className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400"
        >
          Нужно обновить
        </Badge>
      ) : null}
      <span onClick={(e) => e.stopPropagation()} className="inline-flex">
        <StatusInlineEditor lead={lead} onSaved={onRefresh} />
      </span>

      {lead.transferredAt ? (
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

      <div
        className="flex items-center"
        onClick={(e) => e.stopPropagation()}
      >
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Передать"
                disabled={pending}
              >
                <ArrowRightLeft className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuLabel>Передать</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {curators.filter((c) => c.id !== lead.curatorId).length === 0 ? (
              <DropdownMenuItem disabled>
                Нет доступных сотрудников
              </DropdownMenuItem>
            ) : (
              curators
                .filter((c) => c.id !== lead.curatorId)
                .map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    onClick={() => onTransfer(lead.id, c.id)}
                  >
                    <span className="truncate">{c.name}</span>
                    <span className="ml-auto max-w-[50%] truncate text-xs text-muted-foreground">
                      {c.cities?.length ? c.cities.join(', ') : (c.city ?? '')}{' '}
                      · {c.activeLeads} лид.
                    </span>
                  </DropdownMenuItem>
                ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <DeleteLeadButton lead={lead} onDeleted={onRefresh} />
      </div>
    </li>
  )
})
