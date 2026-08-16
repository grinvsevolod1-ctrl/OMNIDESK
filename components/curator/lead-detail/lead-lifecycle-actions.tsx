'use client'

import { Button } from '@/components/ui/button'
import type { LeadCardView } from './types'

/**
 * Действия для лида в финальном статусе: архивировать / вернуть из архива
 * и вернуть в воронку ИИ (если есть диалог). Само условие финальности и
 * обёртка-секция — на стороне родителя.
 */
export function LeadLifecycleActions({
  card,
  pending,
  onToggleArchive,
  onReturnToFunnel,
}: {
  card: LeadCardView
  pending: boolean
  onToggleArchive: (archived: boolean) => void
  onReturnToFunnel: () => void
}) {
  return (
    <>
      <p className="text-sm font-semibold">Жизненный цикл</p>
      <p className="text-xs text-muted-foreground">
        Финальный статус: ежедневное подтверждение больше не требуется.
      </p>
      <div className="flex flex-wrap gap-2">
        {card.archivedAt ? (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => onToggleArchive(false)}
          >
            Вернуть из архива
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => onToggleArchive(true)}
          >
            В архив
          </Button>
        )}
        {card.conversationId ? (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={onReturnToFunnel}
          >
            Вернуть в воронку ИИ
          </Button>
        ) : null}
      </div>
    </>
  )
}
