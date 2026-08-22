'use client'

import { Archive, ArchiveRestore, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isFinalLeadStatus } from '@/lib/lead-status'
import type { LeadCardView } from './types'

/**
 * Жизненный цикл лида. «В архив» доступна с ЛЮБОГО текущего статуса, но
 * не переносит лид сразу: открывает диалог с обязательным выбором нерабочей
 * причины («Игнор» / «Отказался» / «Кинул») и обязательным комментарием
 * (onRequestArchive). Возврат из архива и возврат в воронку ИИ — как раньше.
 */
export function LeadLifecycleActions({
  card,
  pending,
  onRequestArchive,
  onUnarchive,
  onReturnToFunnel,
}: {
  card: LeadCardView
  pending: boolean
  /** Открыть диалог «Перенос в архив» (причина + комментарий). */
  onRequestArchive: () => void
  onUnarchive: () => void
  onReturnToFunnel: () => void
}) {
  const isFinal = isFinalLeadStatus(card.status)
  return (
    <>
      <p className="text-sm font-semibold">Жизненный цикл</p>
      <p className="text-xs text-muted-foreground">
        {card.archivedAt
          ? 'Лид в архиве: ежедневное подтверждение не требуется.'
          : 'В архив — только с нерабочим статусом и комментарием.'}
      </p>
      <div className="flex flex-wrap gap-2">
        {card.archivedAt ? (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={onUnarchive}
          >
            <ArchiveRestore className="size-3.5" />
            Вернуть из архива
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={onRequestArchive}
          >
            <Archive className="size-3.5" />
            В архив
          </Button>
        )}
        {isFinal && card.conversationId ? (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={onReturnToFunnel}
          >
            <Undo2 className="size-3.5" />
            Вернуть в воронку ИИ
          </Button>
        ) : null}
      </div>
    </>
  )
}
