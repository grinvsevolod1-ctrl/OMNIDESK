import { Badge } from '@/components/ui/badge'
import {
  LEAD_STATUS_TONE,
  leadStatusLabel,
  type LeadStatus,
} from '@/lib/lead-status'
import { cn } from '@/lib/utils'

export function LeadStatusBadge({
  status,
  needsUpdate,
  previousStatus,
  className,
}: {
  status: LeadStatus | null
  needsUpdate?: boolean
  previousStatus?: LeadStatus | null
  className?: string
}) {
  if (needsUpdate) {
    return (
      <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
        <Badge
          variant="outline"
          className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400"
        >
          Нужно обновить
        </Badge>
        {previousStatus ? (
          <span className="text-[11px] text-muted-foreground">
            вчера: {leadStatusLabel(previousStatus)}
          </span>
        ) : null}
      </div>
    )
  }
  if (!status) {
    return (
      <Badge
        variant="outline"
        className={cn(
          'border-transparent bg-muted text-muted-foreground',
          className,
        )}
      >
        Не указан
      </Badge>
    )
  }
  const tone = LEAD_STATUS_TONE[status]
  return (
    <Badge
      variant="outline"
      className={cn('gap-1.5 border-transparent', tone.bg, tone.text, className)}
    >
      <span className={cn('size-1.5 rounded-full', tone.dot)} />
      {leadStatusLabel(status)}
    </Badge>
  )
}
