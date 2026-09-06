'use client'

import { memo } from 'react'
import { cn } from '@/lib/utils'
import { ContactAvatar, SourceChip } from '@/components/manager/inbox/atoms'
import { listStamp } from '@/components/manager/inbox/visual'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import type { Conversation } from '@/lib/types'
import type { CuratorConversationStatus } from '@/lib/data/curator-conversations'

/**
 * Строка списка диалогов. Мемоизирована: раньше все строки перерисовывались на
 * каждый рендер родителя (ввод в поиск, realtime-события, router.refresh) —
 * при сотнях диалогов это и давало «лаги». Теперь строка ре-рендерится только
 * при смене своих пропсов, а onSelect — стабильная ссылка из родителя.
 */
export const ConversationRow = memo(function ConversationRow({
  conversation: c,
  isActive,
  leadStatus,
  onSelect,
}: {
  conversation: Conversation
  isActive: boolean
  leadStatus?: CuratorConversationStatus
  onSelect: (id: string) => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(c.id)}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors',
          isActive
            ? 'bg-primary/10 ring-1 ring-primary/30'
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
            <span
              className={cn(
                'truncate text-sm',
                c.unread > 0 ? 'font-semibold text-foreground' : 'font-medium',
              )}
            >
              {c.contactName}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {listStamp(c.lastMessageAt)}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <SourceChip conversation={c} size="xs" />
            <span
              className={cn(
                'truncate text-xs',
                c.unread > 0 ? 'text-foreground/80' : 'text-muted-foreground',
              )}
            >
              {c.lastMessage || '—'}
            </span>
          </div>
          {leadStatus ? (
            <div className="mt-1">
              <LeadStatusBadge
                status={leadStatus.status}
                className="px-1.5 py-0 text-[10px]"
              />
            </div>
          ) : null}
        </div>
        {c.unread > 0 ? (
          <span className="ml-1 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground tabular-nums">
            {c.unread > 99 ? '99+' : c.unread}
          </span>
        ) : null}
      </button>
    </li>
  )
})
