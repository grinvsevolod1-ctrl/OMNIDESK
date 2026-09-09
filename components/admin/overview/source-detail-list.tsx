'use client'

/**
 * Список детализации отчёта источника: вкладка «Написали» (SourceWriter) и
 * вкладки «Передано»/«В работе» (LeadCard). Списки могут быть длинными
 * (сервер отдаёт до 300), поэтому показываются порциями по 25 строк.
 * Вынесено из source-detail-dialog.
 */

import { useState } from 'react'
import { AtSign, Loader2, MapPin, Phone, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { LeadCard } from '@/lib/data/lead-cards-core'
import type { SourceWriter } from '@/lib/data/traffic-sources'
import { LEAD_STATUS_TONE, leadStatusLabel } from '@/lib/lead-status'
import { formatMskDateTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { Segment } from './source-detail-atoms'

const CHANNEL_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  telegram_personal: 'Telegram',
  whatsapp: 'WhatsApp',
  vk: 'VK',
  max: 'MAX',
  livechat: 'Онлайн-чат',
}

export function DetailList({
  segment,
  lead,
  loading,
}: {
  segment: Segment
  lead:
    | {
        writers: SourceWriter[]
        transferred: LeadCard[]
        working: LeadCard[]
      }
    | undefined
  loading: boolean
}) {
  // Списки могут быть длинными (сервер отдаёт до 300) — показываем порциями,
  // чтобы не рендерить сотни строк сразу. Сброс при смене вкладки обеспечивает
  // key={segment} у родителя (компонент перемонтируется).
  const PAGE = 25
  const [visible, setVisible] = useState(PAGE)

  if (loading || !lead) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <span className="sr-only">Загрузка списка</span>
      </div>
    )
  }

  if (segment === 'wrote') {
    if (lead.writers.length === 0) {
      return (
        <ListEmpty text="За выбранный период по этому источнику ещё никто не написал." />
      )
    }
    return (
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col gap-2">
          {lead.writers.slice(0, visible).map((w) => (
            <WriterRow key={w.conversationId} writer={w} />
          ))}
        </ul>
        <ShowMore
          shown={Math.min(visible, lead.writers.length)}
          total={lead.writers.length}
          onMore={() => setVisible((v) => v + PAGE)}
        />
      </div>
    )
  }

  const leads = segment === 'transferred' ? lead.transferred : lead.working
  if (leads.length === 0) {
    return (
      <ListEmpty
        text={
          segment === 'transferred'
            ? 'За выбранный период передач куратору не было.'
            : 'Сейчас нет лидов в статусе «В работе».'
        }
      />
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {leads.slice(0, visible).map((l) => (
          <LeadRow key={l.id} lead={l} segment={segment} />
        ))}
      </ul>
      <ShowMore
        shown={Math.min(visible, leads.length)}
        total={leads.length}
        onMore={() => setVisible((v) => v + PAGE)}
      />
    </div>
  )
}

/** Кнопка «показать ещё» + счётчик «показано N из M». Скрыта, когда всё видно. */
function ShowMore({
  shown,
  total,
  onMore,
}: {
  shown: number
  total: number
  onMore: () => void
}) {
  if (shown >= total) {
    return total > 0 ? (
      <p className="text-center text-xs text-muted-foreground">
        Показаны все {total}
        {total >= 300 ? ' (максимум)' : ''}
      </p>
    ) : null
  }
  return (
    <div className="flex flex-col items-center gap-1.5">
      <Button variant="outline" size="sm" onClick={onMore}>
        Показать ещё
      </Button>
      <span className="text-xs text-muted-foreground">
        Показано {shown} из {total}
      </span>
    </div>
  )
}

function ListEmpty({ text }: { text: string }) {
  return (
    <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
      {text}
    </p>
  )
}

/* ------------------------------ Строка написавшего ------------------------------ */

function WriterRow({ writer }: { writer: SourceWriter }) {
  const handle = writer.handle?.replace(/^@/, '') || ''
  const channel = CHANNEL_LABEL[writer.channelType] ?? writer.channelType
  const tone = writer.leadStatus ? LEAD_STATUS_TONE[writer.leadStatus] : null
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-background/40 px-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {writer.name || 'Без имени'}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {handle ? (
            <span className="flex items-center gap-1">
              <AtSign className="size-3" />
              {handle}
            </span>
          ) : null}
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
            {channel}
          </span>
        </span>
      </span>
      {writer.leadStatus && tone ? (
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
            tone.bg,
            tone.text,
          )}
        >
          <span className={cn('size-1.5 rounded-full', tone.dot)} />
          {leadStatusLabel(writer.leadStatus)}
        </span>
      ) : (
        <Badge
          variant="outline"
          className="shrink-0 border-transparent bg-muted/60 text-[11px] text-muted-foreground"
        >
          Без карточки
        </Badge>
      )}
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatMskDateTime(writer.wroteAt)}
      </span>
    </li>
  )
}

/* ------------------------------ Строка лида ------------------------------ */

/** Контакт лида: @username → телефон → Telegram ID → «—». */
function leadContact(lead: LeadCard): { icon: typeof AtSign; text: string } {
  if (lead.telegramUsername) {
    return { icon: AtSign, text: lead.telegramUsername.replace(/^@/, '') }
  }
  if (lead.phone) return { icon: Phone, text: lead.phone }
  if (lead.telegramId) return { icon: AtSign, text: lead.telegramId }
  return { icon: AtSign, text: '—' }
}

function LeadRow({
  lead,
  segment,
}: {
  lead: LeadCard
  segment: Exclude<Segment, 'wrote'>
}) {
  const contact = leadContact(lead)
  const ContactIcon = contact.icon
  const when = segment === 'transferred' ? lead.transferredAt : lead.createdAt
  const tone = lead.status ? LEAD_STATUS_TONE[lead.status] : null
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-background/40 px-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {lead.fullName || 'Без имени'}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <ContactIcon className="size-3" />
            {contact.text}
          </span>
          {lead.city ? (
            <span className="flex items-center gap-1">
              <MapPin className="size-3" />
              {lead.city}
            </span>
          ) : null}
          {lead.curatorName ? (
            <span className="flex items-center gap-1">
              <Users className="size-3" />
              {lead.curatorName}
            </span>
          ) : null}
        </span>
      </span>
      {lead.status && tone ? (
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
            tone.bg,
            tone.text,
          )}
        >
          <span className={cn('size-1.5 rounded-full', tone.dot)} />
          {leadStatusLabel(lead.status)}
        </span>
      ) : (
        <Badge variant="outline" className="shrink-0 text-xs">
          {leadStatusLabel(lead.status)}
        </Badge>
      )}
      {when ? (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatMskDateTime(when)}
        </span>
      ) : null}
    </li>
  )
}
