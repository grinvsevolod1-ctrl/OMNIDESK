'use client'

import { memo } from 'react'
import { cn } from '@/lib/utils'
import { ContactAvatar, SourceChip } from '@/components/manager/inbox/atoms'
import { listStamp } from '@/components/manager/inbox/visual'
import type { Conversation } from '@/lib/types'

/**
 * Строка списка диалогов руководителя. Отличие от кураторской — подпись
 * «кто ведёт» (имя куратора), потому что в одном списке лежат диалоги всех
 * кураторов команды. Непрочитанное показываем приглушённо: это счётчик
 * КУРАТОРА («он ещё не открыл»), а не самого руководителя. Мемоизирована,
 * onSelect — стабильная ссылка из родителя.
 */
export const HeadConversationRow = memo(function HeadConversationRow({
  conversation: c,
  isActive,
  showCurator,
  onSelect,
}: {
  conversation: Conversation
  isActive: boolean
  /** Скрываем имя куратора, когда список уже отфильтрован по одному. */
  showCurator: boolean
  onSelect: (id: string) => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(c.id)}
        className={cn(
          'relative flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors',
          isActive
            ? 'bg-primary/10 ring-1 ring-inset ring-primary/40 before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-r-full before:bg-primary'
            : 'hover:bg-muted/60',
        )}
      >
        <ContactAvatar
          name={c.contactName}
          channel={c.channelType}
          channelId={c.channelId}
          conversationId={c.id}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{c.contactName}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {listStamp(c.lastMessageAt)}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <SourceChip conversation={c} size="xs" />
            <span className="truncate text-xs text-muted-foreground">
              {c.lastMessage || '—'}
            </span>
          </div>
          {showCurator && c.curatorName ? (
            <div className="mt-1 truncate text-[11px] text-muted-foreground">
              Ведёт: <span className="text-foreground/80">{c.curatorName}</span>
            </div>
          ) : null}
        </div>
        {c.unread > 0 ? (
          <span
            className="ml-1 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-semibold text-muted-foreground tabular-nums"
            title="Не прочитано куратором"
          >
            {c.unread > 99 ? '99+' : c.unread}
          </span>
        ) : null}
      </button>
    </li>
  )
})
