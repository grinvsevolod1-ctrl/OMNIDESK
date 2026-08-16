/**
 * Чип события в истории карточки лида.
 *
 * Журнал хранит не только подтверждения статуса, но и события жизненного
 * цикла: удаление в корзину / восстановление (админ), архив / возврат из
 * архива (менеджер по кадрам или админ), сброс при передаче. Раньше такие
 * записи показывали только дату и имя — было непонятно, ЧТО именно сделали.
 */
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import type { LeadStatusHistoryEntry } from '@/lib/data/lead-history'
import { cn } from '@/lib/utils'

/** Подпись и тон для каждого события жизненного цикла. */
const EVENT_CHIP: Record<
  Exclude<LeadStatusHistoryEntry['reason'], 'confirm'>,
  { label: string; className: string }
> = {
  transfer_reset: {
    label: 'сброс при передаче',
    className: 'bg-muted text-muted-foreground',
  },
  deleted: {
    label: 'удалён в корзину',
    className: 'bg-destructive/15 text-destructive',
  },
  restored: {
    label: 'восстановлен из корзины',
    className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  },
  archived: {
    label: 'перенесён в архив',
    className: 'bg-muted text-muted-foreground',
  },
  unarchived: {
    label: 'возвращён из архива',
    className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  },
}

/**
 * Само событие строки истории: бейдж статуса для подтверждений, цветной чип
 * с понятной подписью для событий жизненного цикла. Причина удаления (note)
 * показывается рядом с чипом.
 */
export function LeadHistoryEvent({
  entry,
}: {
  entry: Pick<LeadStatusHistoryEntry, 'reason' | 'status' | 'note'>
}) {
  if (entry.reason === 'confirm') {
    return entry.status ? <LeadStatusBadge status={entry.status} /> : null
  }
  const chip = EVENT_CHIP[entry.reason]
  return (
    <>
      <span
        className={cn('rounded px-1 py-0.5 text-[10px] font-medium', chip.className)}
      >
        {chip.label}
      </span>
      {entry.note ? (
        <span className="text-muted-foreground">«{entry.note}»</span>
      ) : null}
    </>
  )
}
