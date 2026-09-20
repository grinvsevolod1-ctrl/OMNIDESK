'use client'

import { useMemo, useState } from 'react'
import useSWR from 'swr'
import {
  AtSign,
  Loader2,
  Phone,
  Search,
  Send,
  User2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'

type ToastFn = typeof toast
import {
  listMyOutreachLeadsAction,
  sendFirstOutreachMessageAction,
  setOutreachLeadStatusAction,
} from '@/app/actions/outreach'
import type {
  OutreachLead,
  OutreachLeadStatus,
} from '@/lib/data/outreach-leads'
import { OutreachThread } from './outreach-thread'

const STATUS_META: Record<
  OutreachLeadStatus,
  { label: string; className: string }
> = {
  pending: { label: 'Новый', className: 'bg-primary/15 text-primary' },
  assigned: { label: 'Назначен', className: 'bg-primary/15 text-primary' },
  contacted: {
    label: 'Написали',
    className: 'bg-amber-500/15 text-amber-500',
  },
  replied: { label: 'Ответил', className: 'bg-emerald-500/15 text-emerald-500' },
  won: { label: 'Успех', className: 'bg-emerald-500/15 text-emerald-500' },
  lost: { label: 'Потерян', className: 'bg-muted text-muted-foreground' },
}

const FILTERS: { key: 'active' | 'contacted' | 'all'; label: string }[] = [
  { key: 'active', label: 'В очереди' },
  { key: 'contacted', label: 'В работе' },
  { key: 'all', label: 'Все' },
]

function leadTitle(lead: OutreachLead): string {
  return (
    lead.displayName ||
    (lead.username ? `@${lead.username}` : null) ||
    lead.phone ||
    'Лид без имени'
  )
}

function initials(lead: OutreachLead): string {
  const t = leadTitle(lead).replace(/^@/, '')
  return t.slice(0, 2).toUpperCase()
}

export function OutreachView({
  initialLeads,
}: {
  initialLeads: OutreachLead[]
}) {
  const [filter, setFilter] = useState<'active' | 'contacted' | 'all'>('active')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(
    initialLeads[0]?.id ?? null,
  )

  const { data: leads = initialLeads, mutate } = useSWR(
    'outreach-leads',
    () => listMyOutreachLeadsAction(),
    { fallbackData: initialLeads, refreshInterval: 15000 },
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return leads.filter((l) => {
      if (filter === 'active' && !['pending', 'assigned'].includes(l.status))
        return false
      if (
        filter === 'contacted' &&
        !['contacted', 'replied'].includes(l.status)
      )
        return false
      if (!q) return true
      return (
        leadTitle(l).toLowerCase().includes(q) ||
        (l.username ?? '').toLowerCase().includes(q) ||
        (l.rawText ?? '').toLowerCase().includes(q)
      )
    })
  }, [leads, filter, search])

  const selected = leads.find((l) => l.id === selectedId) ?? null

  const counts = useMemo(
    () => ({
      active: leads.filter((l) => ['pending', 'assigned'].includes(l.status))
        .length,
      contacted: leads.filter((l) =>
        ['contacted', 'replied'].includes(l.status),
      ).length,
      all: leads.length,
    }),
    [leads],
  )

  return (
    <div className="flex h-[calc(100dvh-var(--app-header-h,3.5rem))] flex-col">
      <header className="border-b border-border px-4 py-4 sm:px-6">
        <h1 className="text-balance text-xl font-semibold text-foreground">
          Исходящие
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Лиды из бота-приёмника. Пишите первым — система сама подберёт прогретый
          аккаунт без спам-блока.
        </p>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(320px,380px)_1fr]">
        {/* Очередь лидов */}
        <aside
          className={cn(
            'flex min-h-0 flex-col border-b border-border lg:border-b-0 lg:border-r',
            selected && 'hidden lg:flex',
          )}
        >
          <div className="space-y-3 border-b border-border p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Поиск по имени, @username, тексту"
                className="pl-9"
              />
            </div>
            <div className="flex gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={cn(
                    'flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                    filter === f.key
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:text-foreground',
                  )}
                >
                  {f.label}
                  <span className="ml-1 opacity-70">{counts[f.key]}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
                <Send className="size-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  {leads.length === 0
                    ? 'Пока нет лидов. Они появятся, как только придут из бота.'
                    : 'Ничего не найдено по фильтру.'}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {filtered.map((lead) => {
                  const meta = STATUS_META[lead.status]
                  return (
                    <li key={lead.id}>
                      <button
                        onClick={() => setSelectedId(lead.id)}
                        className={cn(
                          'flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/60',
                          selectedId === lead.id && 'bg-muted',
                        )}
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                          {initials(lead)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              {leadTitle(lead)}
                            </span>
                            <Badge
                              variant="secondary"
                              className={cn(
                                'shrink-0 border-0 text-[10px]',
                                meta.className,
                              )}
                            >
                              {meta.label}
                            </Badge>
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {lead.rawText || lead.forwardedFrom || '—'}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* Детали лида */}
        <section className={cn('min-h-0', !selected && 'hidden lg:block')}>
          {selected ? (
            <LeadDetail
              key={selected.id}
              lead={selected}
              onBack={() => setSelectedId(null)}
              onChanged={() => mutate()}
              toast={toast}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
              <User2 className="size-10 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">
                Выберите лид, чтобы написать первым.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function LeadDetail({
  lead,
  onBack,
  onChanged,
  toast,
}: {
  lead: OutreachLead
  onBack: () => void
  onChanged: () => void
  toast: ToastFn
}) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const meta = STATUS_META[lead.status]
  const canWrite = lead.status === 'pending' || lead.status === 'assigned'

  async function handleSend() {
    if (!message.trim() || sending) return
    setSending(true)
    try {
      const res = await sendFirstOutreachMessageAction({
        leadId: lead.id,
        message: message.trim(),
      })
      if (res.ok) {
        toast.success(res.message || 'Готово')
      } else {
        toast.error(res.message || 'Не отправлено')
      }
      if (res.ok) {
        setMessage('')
        onChanged()
      }
    } finally {
      setSending(false)
    }
  }

  async function handleStatus(status: OutreachLeadStatus) {
    const res = await setOutreachLeadStatusAction(lead.id, status)
    if (res.ok) {
      toast.success(res.message || 'Статус обновлён')
      onChanged()
    } else {
      toast.error(res.message || 'Ошибка')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-3 border-b border-border p-4 sm:p-6">
        <Button
          variant="ghost"
          size="sm"
          className="lg:hidden"
          onClick={onBack}
        >
          Назад
        </Button>
        <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
          {leadTitle(lead).replace(/^@/, '').slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">
              {leadTitle(lead)}
            </h2>
            <Badge
              variant="secondary"
              className={cn('border-0', meta.className)}
            >
              {meta.label}
            </Badge>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {lead.username && (
              <span className="flex items-center gap-1">
                <AtSign className="size-3" />
                {lead.username}
              </span>
            )}
            {lead.phone && (
              <span className="flex items-center gap-1">
                <Phone className="size-3" />
                {lead.phone}
              </span>
            )}
            {lead.forwardedFrom && (
              <span className="truncate">из: {lead.forwardedFrom}</span>
            )}
          </div>
        </div>
      </div>

      {lead.rawText && (
        <div className="border-b border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground sm:px-6">
          <p className="whitespace-pre-wrap">{lead.rawText}</p>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <OutreachThread leadId={lead.id} status={lead.status} />
      </div>

      {canWrite ? (
        <div className="border-t border-border p-3 sm:p-4">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                (e.metaKey || e.ctrlKey) &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault()
                void handleSend()
              }
            }}
            placeholder="Первое сообщение лиду…"
            rows={3}
            className="resize-none"
          />
          <div className="mt-2 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Отправится с прогретого аккаунта пула. ⌘/Ctrl+Enter
            </p>
            <Button onClick={handleSend} disabled={!message.trim() || sending}>
              {sending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              Написать первым
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 border-t border-border p-3 sm:p-4">
          <span className="text-xs text-muted-foreground">Отметить лид:</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleStatus('won')}
          >
            Успех
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleStatus('lost')}
          >
            Потерян
          </Button>
        </div>
      )}
    </div>
  )
}
