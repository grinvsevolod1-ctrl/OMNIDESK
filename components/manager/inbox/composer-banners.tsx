'use client'

import { Pencil, Reply, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Message } from '@/lib/types'

/**
 * The edit / reply preview banners shown above the composer (Telegram-style).
 * Mutually exclusive by construction: starting one cancels the other in
 * useMessageActions. Extracted verbatim from inbox-view.tsx.
 */
export function ComposerBanners({
  editTarget,
  replyTarget,
  onCancelEdit,
  onCancelReply,
}: {
  editTarget: Message | null
  replyTarget: Message | null
  onCancelEdit: () => void
  onCancelReply: () => void
}) {
  return (
    <>
      {/* Edit banner — mirrors the reply banner, Telegram-style. */}
      {editTarget ? (
        <div className="flex items-center gap-2 border-t border-border bg-muted/40 px-3 py-2">
          <Pencil className="size-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1 border-l-2 border-primary/60 pl-2">
            <p className="text-xs font-semibold text-primary">
              Редактирование
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {editTarget.body}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={onCancelEdit}
            aria-label="Отменить редактирование"
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : null}

      {/* Reply preview banner */}
      {replyTarget ? (
        <div className="flex items-center gap-2 border-t border-border bg-muted/40 px-3 py-2">
          <Reply className="size-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1 border-l-2 border-primary/60 pl-2">
            <p className="text-xs font-semibold text-primary">
              Ответ · {replyTarget.author || 'Сообщение'}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {replyTarget.body || (replyTarget.mediaType ? '[вложение]' : '')}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={onCancelReply}
            aria-label="Отменить ответ"
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : null}
    </>
  )
}
