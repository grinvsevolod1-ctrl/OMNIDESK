'use client'

import type { ReactNode } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Reply,
  SmilePlus,
  Copy,
  Forward,
  Trash2,
  X,
} from 'lucide-react'
import type { Message } from '@/lib/types'

/** Telegram-style quick reactions shown as a row at the top of the menu. */
const QUICK_REACTIONS = ['👍', '❤️', '🔥', '😂', '😮', '😢', '🙏']

export interface ForwardTarget {
  id: string
  name: string
}

/**
 * Wraps a Telegram message bubble with a right-click context menu offering the
 * familiar Telegram actions: react, reply, copy, forward, delete. The currently
 * applied "fromMe" reaction (if any) is highlighted and clicking it again clears
 * it.
 */
export function MessageContextMenu({
  message,
  forwardTargets,
  onReply,
  onReact,
  onCopy,
  onForward,
  onDelete,
  children,
}: {
  message: Message
  forwardTargets: ForwardTarget[]
  onReply: (m: Message) => void
  onReact: (m: Message, emoji: string) => void
  onCopy: (m: Message) => void
  onForward: (m: Message, toConversationId: string) => void
  onDelete: (m: Message) => void
  children: ReactNode
}) {
  const myReaction = message.reactions?.find((r) => r.fromMe)?.emoji ?? null
  const hasText = Boolean(message.body && message.body.trim())

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          // The trigger renders the bubble itself so the whole message is the
          // right-click target.
          <div className="w-fit max-w-full" />
        }
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        {/* Quick reaction row */}
        <div className="mb-1 flex items-center justify-between gap-0.5 px-1 py-0.5">
          {QUICK_REACTIONS.map((emoji) => {
            const active = myReaction === emoji
            return (
              <button
                key={emoji}
                type="button"
                onClick={() => onReact(message, active ? '' : emoji)}
                className={
                  'flex size-8 items-center justify-center rounded-full text-lg transition-colors hover:bg-accent ' +
                  (active ? 'bg-primary/15 ring-1 ring-primary' : '')
                }
                aria-label={active ? `Убрать реакцию ${emoji}` : `Реакция ${emoji}`}
              >
                {emoji}
              </button>
            )
          })}
        </div>
        <ContextMenuSeparator />

        <ContextMenuItem onClick={() => onReply(message)}>
          <Reply />
          Ответить
        </ContextMenuItem>

        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <SmilePlus />
            Реакция
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="grid grid-cols-4 gap-0.5">
            {QUICK_REACTIONS.map((emoji) => (
              <ContextMenuItem
                key={emoji}
                className="justify-center text-lg"
                onClick={() => onReact(message, myReaction === emoji ? '' : emoji)}
              >
                {emoji}
              </ContextMenuItem>
            ))}
            {myReaction ? (
              <ContextMenuItem
                className="col-span-4 justify-center text-sm"
                onClick={() => onReact(message, '')}
              >
                <X />
                Убрать
              </ContextMenuItem>
            ) : null}
          </ContextMenuSubContent>
        </ContextMenuSub>

        {hasText ? (
          <ContextMenuItem onClick={() => onCopy(message)}>
            <Copy />
            Копировать текст
          </ContextMenuItem>
        ) : null}

        {forwardTargets.length > 0 ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Forward />
              Переслать
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="max-h-72 overflow-y-auto">
              {forwardTargets.map((t) => (
                <ContextMenuItem
                  key={t.id}
                  onClick={() => onForward(message, t.id)}
                >
                  {t.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : null}

        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => onDelete(message)}>
          <Trash2 />
          Удалить
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export { QUICK_REACTIONS }
