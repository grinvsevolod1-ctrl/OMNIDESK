'use client'

/**
 * Bottom sheet (long-press / context menu) with actions for one message:
 * reply, copy, edit (inbound text only), delete. Presentational — the
 * actual action handling lives in use-god-composer's menuAction.
 */

import type React from 'react'
import { Copy, CornerUpLeft, Pencil, Trash2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { Message } from '@/lib/types'
import { snippetOf } from './reply'

export type SheetAction = 'reply' | 'copy' | 'edit' | 'delete'

interface MessageActionSheetProps {
  message: Message
  onAction: (action: SheetAction) => void
  onClose: () => void
}

export function MessageActionSheet({
  message,
  onAction,
  onClose,
}: MessageActionSheetProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-sm rounded-t-2xl bg-card p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-lg md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        role="menu"
        aria-label="Действия с сообщением"
      >
        <p className="truncate px-3 py-2 text-xs text-muted-foreground">
          {snippetOf(message) || 'Сообщение'}
        </p>
        <SheetButton
          icon={<CornerUpLeft className="size-4" />}
          label="Ответить"
          onClick={() => onAction('reply')}
        />
        <SheetButton
          icon={<Copy className="size-4" />}
          label="Копировать"
          onClick={() => onAction('copy')}
        />
        {message.direction === 'in' && !message.mediaType && (
          <SheetButton
            icon={<Pencil className="size-4" />}
            label="Изменить"
            onClick={() => onAction('edit')}
          />
        )}
        <SheetButton
          icon={<Trash2 className="size-4" />}
          label="Удалить"
          destructive
          onClick={() => onAction('delete')}
        />
      </div>
    </div>
  )
}

/** One row of the message action sheet. */
function SheetButton({
  icon,
  label,
  onClick,
  destructive,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  destructive?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition-colors hover:bg-muted',
        destructive ? 'text-destructive' : 'text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  )
}
