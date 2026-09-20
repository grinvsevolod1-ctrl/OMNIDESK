'use client'

import useSWR from 'swr'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getOutreachThreadAction } from '@/app/actions/outreach'
import type { OutreachLeadStatus } from '@/lib/data/outreach-leads'

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

export function OutreachThread({
  leadId,
  status,
}: {
  leadId: string
  status: OutreachLeadStatus
}) {
  const { data: messages, isLoading } = useSWR(
    ['outreach-thread', leadId],
    () => getOutreachThreadAction(leadId),
    { refreshInterval: status === 'contacted' ? 15000 : 0 },
  )

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!messages || messages.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Переписки пока нет. Напишите первым — сообщение появится здесь.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {messages.map((m) => (
        <div
          key={m.id}
          className={cn(
            'max-w-[80%] rounded-2xl px-3 py-2 text-sm',
            m.direction === 'out'
              ? 'self-end bg-primary text-primary-foreground'
              : 'self-start bg-muted text-foreground',
          )}
        >
          <p className="whitespace-pre-wrap">{m.body}</p>
          <p
            className={cn(
              'mt-1 text-[10px]',
              m.direction === 'out'
                ? 'text-primary-foreground/70'
                : 'text-muted-foreground',
            )}
          >
            {formatTime(m.createdAt)}
          </p>
        </div>
      ))}
    </div>
  )
}
