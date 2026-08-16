'use client'

/**
 * Один пузырь сообщения в личном мессенджере (god-панель, вкладка «Telegram»):
 * цитата, медиа, текст, статус доставки и hover-действия (ответ/правка/удаление).
 * Вынесено из personal-messenger.tsx. Часть god-панели — инварианты AGENTS.md §4.
 */

import { Check, CheckCheck, Pencil, Reply, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PersonalMessage } from '@/app/actions/admin-secret/telegram-personal'
import { MessageMediaBlock, formatTime } from './messenger-shared'

export function MessageBubble({
  msg,
  reply,
  channelId,
  peerId,
  onReply,
  onEdit,
  onDelete,
}: {
  msg: PersonalMessage
  /** The message this one replies to, already resolved by the parent. */
  reply: PersonalMessage | null
  channelId: string
  peerId: string
  onReply: (msg: PersonalMessage) => void
  onEdit: (msg: PersonalMessage) => void
  onDelete: (msg: PersonalMessage) => void
}) {
  return (
    <div
      className={cn('group flex', msg.outgoing ? 'justify-end' : 'justify-start')}
    >
      <div
        className={cn(
          'relative max-w-[78%] rounded-2xl px-3 py-2',
          msg.outgoing
            ? 'rounded-br-sm bg-primary text-primary-foreground'
            : 'rounded-bl-sm bg-muted text-foreground',
        )}
      >
        {reply && (
          <div
            className={cn(
              'mb-1.5 rounded-md border-l-2 px-2 py-1 text-xs',
              msg.outgoing
                ? 'border-primary-foreground/50 bg-primary-foreground/10 text-primary-foreground/90'
                : 'border-primary/60 bg-background/50 text-muted-foreground',
            )}
          >
            <p className="line-clamp-2">
              {reply.text || (reply.mediaType ? 'Вложение' : '…')}
            </p>
          </div>
        )}
        {msg.mediaType && (
          <div className={cn(msg.text && 'mb-1.5')}>
            <MessageMediaBlock channelId={channelId} peer={peerId} message={msg} />
          </div>
        )}
        {msg.text && (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {msg.text}
          </p>
        )}
        <div
          className={cn(
            'mt-0.5 flex items-center justify-end gap-1 text-[10px]',
            msg.outgoing ? 'text-primary-foreground/70' : 'text-muted-foreground',
          )}
        >
          <span>{formatTime(msg.date)}</span>
          {msg.outgoing &&
            (msg.editable ? (
              <CheckCheck className="size-3" />
            ) : (
              <Check className="size-3" />
            ))}
        </div>

        {/* Действия над сообщением */}
        <div
          className={cn(
            'absolute top-0 hidden items-center gap-0.5 rounded-lg border border-border bg-popover p-0.5 shadow-sm group-hover:flex',
            msg.outgoing ? '-left-2 -translate-x-full' : '-right-2 translate-x-full',
          )}
        >
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Ответить"
            onClick={() => onReply(msg)}
          >
            <Reply className="size-3.5" />
          </Button>
          {msg.outgoing && msg.editable && !msg.mediaType && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Редактировать"
              onClick={() => onEdit(msg)}
            >
              <Pencil className="size-3.5" />
            </Button>
          )}
          {msg.outgoing && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-destructive hover:text-destructive"
              aria-label="Удалить"
              onClick={() => onDelete(msg)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
