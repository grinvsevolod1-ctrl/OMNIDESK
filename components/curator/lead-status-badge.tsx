import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import {
  LEAD_STATUS_TONE,
  leadStatusLabel,
  type LeadStatus,
} from '@/lib/lead-status'
import { formatMskDateTime } from '@/lib/time'
import { cn } from '@/lib/utils'

/** Аккуратная подпись «когда присвоен статус» рядом с бейджем (МСК). */
function StatusAssignedAt({ at }: { at: string }) {
  return (
    <time
      dateTime={at}
      className="whitespace-nowrap text-[11px] leading-none tabular-nums text-muted-foreground"
    >
      {formatMskDateTime(at)}
    </time>
  )
}

/**
 * Обернуть бейдж подписью времени присвоения статуса, если оно задано.
 * Когда `at` пустой — возвращаем бейдж как есть (без обёртки), чтобы не менять
 * раскладку в местах, где время не нужно (списки чатов, «просто написавшие»).
 */
function withAssignedAt(badge: ReactNode, at: string | null | undefined) {
  if (!at) return badge
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {badge}
      <StatusAssignedAt at={at} />
    </span>
  )
}

export function LeadStatusBadge({
  status,
  needsUpdate,
  previousStatus,
  at,
  className,
}: {
  status: LeadStatus | null
  needsUpdate?: boolean
  previousStatus?: LeadStatus | null
  /**
   * ISO-время присвоения текущего статуса (statusConfirmedAt). Когда задано —
   * рядом с бейджем аккуратно выводятся дата и время в МСК. Для NEW/без
   * подтверждения обычно null, и подпись не показывается.
   */
  at?: string | null
  className?: string
}) {
  // «NEW» — лид только зашёл от менеджера: зелёный бейдж важнее подсказки
  // «Нужно обновить» (подтверждение статуса всё равно требуется — дневной
  // гейт это учитывает, но визуально свежий лид всегда помечен как NEW).
  if (status === 'new') {
    const tone = LEAD_STATUS_TONE.new
    return withAssignedAt(
      <Badge
        variant="outline"
        className={cn(
          'gap-1.5 border-transparent font-semibold',
          tone.bg,
          tone.text,
          className,
        )}
      >
        <span className={cn('size-1.5 rounded-full', tone.dot)} />
        NEW
      </Badge>,
      at,
    )
  }
  if (needsUpdate) {
    return (
      <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1', className)}>
        <Badge
          variant="outline"
          className="border-transparent bg-amber-500/15 font-medium text-amber-700 dark:text-amber-400"
        >
          Нужно обновить
        </Badge>
        {previousStatus || at ? (
          // «вчера: …» и время присвоения — единый тихий кластер с точкой-
          // разделителем; каждый фрагмент не переносится посередине.
          <span className="inline-flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground">
            {previousStatus ? (
              <span className="whitespace-nowrap">
                вчера: {leadStatusLabel(previousStatus)}
              </span>
            ) : null}
            {previousStatus && at ? (
              <span aria-hidden className="opacity-40">
                ·
              </span>
            ) : null}
            {at ? (
              <time dateTime={at} className="whitespace-nowrap tabular-nums">
                {formatMskDateTime(at)}
              </time>
            ) : null}
          </span>
        ) : null}
      </div>
    )
  }
  if (!status) {
    return withAssignedAt(
      <Badge
        variant="outline"
        className={cn(
          'border-transparent bg-muted text-muted-foreground',
          className,
        )}
      >
        Не указан
      </Badge>,
      at,
    )
  }
  const tone = LEAD_STATUS_TONE[status]
  return withAssignedAt(
    <Badge
      variant="outline"
      className={cn('gap-1.5 border-transparent', tone.bg, tone.text, className)}
    >
      <span className={cn('size-1.5 rounded-full', tone.dot)} />
      {leadStatusLabel(status)}
    </Badge>,
    at,
  )
}
