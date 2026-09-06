'use client'

import { CalendarClock, Radio, UserCheck, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ContactAvatar, MetaRows } from '@/components/manager/inbox/atoms'
import { CHANNEL_VISUAL, listStamp } from '@/components/manager/inbox/visual'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import { LeadStatusForm } from '@/components/curator/lead-panel-forms'
import type { Conversation, PanelChannelType } from '@/lib/types'
import type { CuratorConversationStatus } from '@/lib/data/curator-conversations'

/** Правая панель «Сведения» открытого диалога куратора. */
export function CuratorInfoPanel({
  active,
  leadStatus,
  onStatusSaved,
  onClose,
}: {
  active: Conversation
  leadStatus?: CuratorConversationStatus
  onStatusSaved: () => void
  onClose: () => void
}) {
  const channelShort =
    CHANNEL_VISUAL[active.channelType as PanelChannelType]?.short ??
    active.channelType
  const rows: { icon: typeof Radio; label: string; value: string }[] = []
  rows.push({ icon: Radio, label: 'Канал', value: channelShort })
  if (active.managerName)
    rows.push({ icon: UserCheck, label: 'Передал', value: active.managerName })
  if (active.transferredToCuratorAt)
    rows.push({
      icon: CalendarClock,
      label: 'Передан вам',
      value: listStamp(active.transferredToCuratorAt),
    })

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full max-w-sm flex-col border-l border-border bg-card shadow-xl md:static md:z-auto md:w-80 md:shadow-none lg:w-[22rem]">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Сведения</h2>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Закрыть сведения"
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="scrollbar-thin flex-1 overflow-y-auto p-4">
        <div className="flex flex-col items-center gap-2 pb-4 text-center">
          <ContactAvatar
            name={active.contactName}
            channel={active.channelType}
            channelId={active.channelId}
            conversationId={active.id}
            size="lg"
          />
          <div>
            <p className="text-sm font-semibold">{active.contactName}</p>
            {active.contactUsername ? (
              <p className="text-xs text-muted-foreground">
                @{active.contactUsername}
              </p>
            ) : null}
          </div>
          {leadStatus ? (
            <LeadStatusBadge status={leadStatus.status} />
          ) : null}
        </div>

        <dl className="flex flex-col gap-3 border-t border-border pt-4">
          {rows.map((r, i) => (
            <div key={i} className="flex items-start gap-2.5 text-xs">
              <r.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <dt className="text-muted-foreground">{r.label}</dt>
                <dd className="font-medium text-foreground">{r.value}</dd>
              </div>
            </div>
          ))}
        </dl>

        {/* Кураторский статус лида: свой набор статусов + обязательный
            комментарий. Тот же action и форма, что и в «Мои лиды» — куратор
            подтверждает статус, не выходя из переписки. -mx-4 распахивает
            секцию на всю ширину панели (форма имеет собственные поля px-4). */}
        {leadStatus ? (
          <div className="-mx-4 mt-4 border-t border-border">
            <LeadStatusForm
              leadCardId={leadStatus.leadCardId}
              currentStatus={leadStatus.status}
              onSaved={onStatusSaved}
              variant="curator"
            />
          </div>
        ) : null}

        {/* Контекст посетителя (лайв-чат сайта) */}
        {active.meta ? (
          <div className="mt-4 border-t border-border pt-4">
            <p className="mb-3 text-xs font-semibold text-muted-foreground">
              Посетитель сайта
            </p>
            <MetaRows meta={active.meta} />
          </div>
        ) : null}
      </div>
    </aside>
  )
}
