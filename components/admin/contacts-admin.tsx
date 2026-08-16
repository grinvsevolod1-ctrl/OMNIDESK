'use client'

import { useState } from 'react'
import { Download, Send, Users2 } from 'lucide-react'
import { channelIcon } from '@/components/channel-icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatMskDateTimeNumeric } from '@/lib/time'
import { downloadText } from '@/lib/vault-utils'
import { useLeadStatusMeta } from '@/components/dictionaries-provider'
import type { ContactChannelGroup, ContactRecord } from '@/lib/types'
import type { Dictionaries } from '@/lib/dictionaries'
import { cn } from '@/lib/utils'

/** Per-channel accent, mirroring the Accounts tab palette. */
const CHANNEL_ACCENT: Record<string, string> = {
  telegram: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  whatsapp:
    'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  vk: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
  max: 'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  livechat:
    'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
}

function csvCell(value: string): string {
  const v = value ?? ''
  return /[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** Build a CSV export for one channel's contacts. */
function contactsToCSV(
  contacts: ContactRecord[],
  leadStatuses: Dictionaries['leadStatuses'],
): string {
  const header = [
    'name',
    'identifier',
    'username',
    'channel',
    'manager',
    'status',
    'created_at',
    'last_message_at',
  ]
  const rows = contacts.map((c) =>
    [
      c.contactName,
      c.contactHandle,
      c.contactUsername ?? '',
      c.channelName ?? c.channelType,
      c.managerName ?? '',
      leadStatuses[c.status]?.label ?? c.status,
      c.createdAt,
      c.lastMessageAt,
    ]
      .map((cell) => csvCell(String(cell)))
      .join(','),
  )
  return [header.join(','), ...rows].join('\n')
}

export function ContactsAdmin({ groups }: { groups: ContactChannelGroup[] }) {
  const leadStatuses = useLeadStatusMeta()
  const [openType, setOpenType] = useState<string | null>(null)
  const active = groups.find((g) => g.channelType === openType) ?? null
  const total = groups.reduce((sum, g) => sum + g.count, 0)

  function exportGroup(group: ContactChannelGroup) {
    const csv = contactsToCSV(group.contacts, leadStatuses)
    downloadText(`contacts-${group.channelType}.csv`, csv, 'text/csv')
  }

  return (
    <div className="flex flex-col gap-6">
      {total === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-3 p-12 text-center">
          <Users2 className="size-8 text-muted-foreground" />
          <div>
            <p className="font-medium">Контактов пока нет</p>
            <p className="text-sm text-muted-foreground">
              Как только клиенты начнут писать, они появятся здесь.
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((group) => {
            const Icon = channelIcon(group.channelType)
            return (
              <Card
                key={group.channelType}
                className="flex flex-col gap-4 p-5 transition-colors hover:border-primary/40"
              >
                <div className="flex items-center justify-between">
                  <div
                    className={cn(
                      'flex size-11 items-center justify-center rounded-xl border',
                      CHANNEL_ACCENT[group.channelType] ??
                        'border-border bg-muted text-foreground',
                    )}
                  >
                    <Icon className="size-6" />
                  </div>
                  <span className="text-2xl font-semibold tabular-nums">
                    {group.count}
                  </span>
                </div>
                <div>
                  <p className="font-medium">{group.label}</p>
                  <p className="text-sm text-muted-foreground">
                    {group.count === 0
                      ? 'Нет контактов'
                      : `${group.count} ${plural(group.count)}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="flex-1"
                    disabled={group.count === 0}
                    onClick={() => setOpenType(group.channelType)}
                  >
                    Открыть
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label="Экспорт в CSV"
                    disabled={group.count === 0}
                    onClick={() => exportGroup(group)}
                  >
                    <Download className="size-4" />
                  </Button>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      <Dialog
        open={active != null}
        onOpenChange={(v) => !v && setOpenType(null)}
      >
        <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col">
          {active ? (
            <>
              <DialogHeader>
                <DialogTitle>{active.label}</DialogTitle>
                <DialogDescription>
                  {active.count} {plural(active.count)} в этом канале
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => exportGroup(active)}
                >
                  <Download className="size-4" />
                  Экспорт CSV
                </Button>
                {/* Broadcast is intentionally disabled for now — wired up later. */}
                <Button size="sm" variant="outline" disabled title="Скоро">
                  <Send className="size-4" />
                  Рассылка
                </Button>
                <Badge variant="secondary" className="ml-auto">
                  скоро
                </Badge>
              </div>

              <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Имя</th>
                      <th className="px-3 py-2 font-medium">Идентификатор</th>
                      <th className="px-3 py-2 font-medium">Менеджер</th>
                      <th className="px-3 py-2 font-medium">Статус</th>
                      <th className="px-3 py-2 font-medium">Последнее</th>
                    </tr>
                  </thead>
                  <tbody>
                    {active.contacts.map((c) => (
                      <tr
                        key={c.id}
                        className="border-t border-border/60 hover:bg-muted/40"
                      >
                        <td className="px-3 py-2">
                          <div className="font-medium">{c.contactName}</div>
                          {c.contactUsername ? (
                            <div className="font-mono text-xs text-muted-foreground">
                              @{c.contactUsername.replace(/^@/, '')}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">
                          <span className="font-mono text-xs text-muted-foreground">
                            {c.contactHandle || '—'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {c.managerName ?? '—'}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="outline" className="text-xs">
                            {leadStatuses[c.status]?.label ?? c.status}
                          </Badge>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                          {formatMskDateTimeNumeric(c.lastMessageAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function plural(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'контакт'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'контакта'
  return 'контактов'
}
