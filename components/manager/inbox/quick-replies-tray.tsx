'use client'

import { ChevronDown, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { QuickReply } from '@/lib/types'

/**
 * Collapsible tray of the manager's saved canned answers, shown above the
 * composer. One tap inserts a reply into the draft. Extracted verbatim from
 * message-composer.tsx — it is purely presentational (open state is owned by
 * the composer) and touches none of the composer's hot-path refs, so it lives
 * on its own to keep the composer's coupled send-core smaller.
 */
export function QuickRepliesTray({
  quickReplies,
  open,
  onToggleOpen,
  onInsert,
}: {
  quickReplies: QuickReply[]
  open: boolean
  onToggleOpen: () => void
  onInsert: (body: string) => void
}) {
  return (
    <div className="border-b border-border/60 px-3 pt-2">
      <button
        type="button"
        onClick={onToggleOpen}
        className="flex items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={open}
      >
        <Zap className="size-3.5" />
        Автоответы
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
          {quickReplies.length}
        </span>
        <ChevronDown
          className={cn('size-3.5 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open ? (
        <div className="scrollbar-thin -mx-1 mt-2 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto px-1 pb-2">
          {quickReplies.map((qr) => (
            <button
              key={qr.id}
              type="button"
              onClick={() => onInsert(qr.body)}
              title={qr.body}
              className="max-w-[15rem] truncate rounded-full border border-border bg-muted/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
            >
              {qr.title?.trim() || qr.body}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
