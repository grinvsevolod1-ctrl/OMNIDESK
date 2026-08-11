import type { ReactNode } from 'react'
import { LeadHistoryEvent } from '@/components/shared/lead-history-event'
import { formatDateTime } from './format'
import type { LeadStatusHistoryView, LeadTransferView } from './types'

/** Одна строка истории: дата слева + произвольное событие. */
function HistoryRow({ date, children }: { date: string; children: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span>{formatDateTime(date)}</span>
      {children}
    </li>
  )
}

/** Заголовок + список — общий каркас для блоков истории. */
function HistoryBlock({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="flex flex-col gap-1">{children}</ul>
    </div>
  )
}

/** История статусов и история передач лида (каждый блок — если есть записи). */
export function LeadHistory({
  statusHistory,
  transfers,
}: {
  statusHistory: LeadStatusHistoryView[]
  transfers: LeadTransferView[]
}) {
  return (
    <>
      {statusHistory.length > 0 ? (
        <HistoryBlock title="История статусов">
          {statusHistory.slice(0, 10).map((h) => (
            <HistoryRow key={h.id} date={h.createdAt}>
              <LeadHistoryEvent entry={h} />
              {h.curatorName ? <span>— {h.curatorName}</span> : null}
            </HistoryRow>
          ))}
        </HistoryBlock>
      ) : null}

      {transfers.length > 0 ? (
        <HistoryBlock title="История передач">
          {transfers.map((t) => (
            <HistoryRow key={t.id} date={t.createdAt}>
              <span>
                {t.fromCuratorName
                  ? `${t.fromCuratorName} → ${t.toCuratorName ?? '—'}`
                  : `→ ${t.toCuratorName ?? '—'}`}
              </span>
              <span className="rounded bg-muted px-1 py-0.5 text-[10px]">
                {t.initiatedByRole === 'admin' ? 'админ' : 'менеджер'}
              </span>
            </HistoryRow>
          ))}
        </HistoryBlock>
      ) : null}
    </>
  )
}
