'use client'

import { useState, useTransition } from 'react'
import {
  Calendar,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  MessageSquare,
  Plus,
  VideoOff,
} from 'lucide-react'
import { TelemostIcon } from '@/components/channel-icons'
import { toast } from 'sonner'
import {
  createStandaloneMeetingAction,
} from '@/app/actions/conversations'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { formatMskDateTime } from '@/lib/time'
import type { TelemostMeetingRecord } from '@/lib/data'

interface MeetingsViewProps {
  meetings: TelemostMeetingRecord[]
  telemostEnabled: boolean
}

export function MeetingsView({ meetings, telemostEnabled }: MeetingsViewProps) {
  const [pending, startTransition] = useTransition()
  const [localMeetings, setLocalMeetings] = useState(meetings)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  function copyLink(id: string, url: string) {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2000)
    })
  }

  function createMeeting() {
    if (!telemostEnabled) {
      toast.error('Телемост не настроен. Обратитесь к администратору.')
      return
    }
    startTransition(async () => {
      const res = await createStandaloneMeetingAction()
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      if (res.joinUrl) {
        navigator.clipboard.writeText(res.joinUrl).catch(() => {})
        toast.success('Встреча создана. Ссылка скопирована в буфер обмена.')
        // Optimistic prepend so the manager sees the new entry immediately.
        setLocalMeetings((prev) => [
          {
            id: crypto.randomUUID(),
            conversationId: null,
            contactName: null,
            joinUrl: res.joinUrl!,
            delivered: false,
            createdAt: new Date().toISOString(),
          },
          ...prev,
        ])
      }
    })
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Action header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-pretty text-xl font-semibold tracking-tight md:text-2xl">
            Видеовстречи
          </h1>
          <p className="text-sm text-muted-foreground">
            Создавайте видеовстречи Яндекс Телемост и делитесь ссылками с
            клиентами. История встреч за последние 30 записей.
          </p>
        </div>
        <Button
          onClick={createMeeting}
          disabled={pending || !telemostEnabled}
          className="shrink-0"
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          Новая встреча
        </Button>
      </div>

      {/* Telemost not configured notice */}
      {!telemostEnabled ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <VideoOff className="size-10 text-muted-foreground/50" />
            <div className="space-y-1">
              <p className="font-medium">Телемост не подключён</p>
              <p className="max-w-xs text-sm text-muted-foreground">
                Администратор должен настроить OAuth-токен Яндекс Телемост в
                разделе «Настройки — Телемост».
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Stats row */}
      {telemostEnabled && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard
            icon={TelemostIcon}
            label="Всего встреч"
            value={localMeetings.length}
          />
          <StatCard
            icon={MessageSquare}
            label="Отправлено клиентам"
            value={localMeetings.filter((m) => m.delivered).length}
          />
          <StatCard
            icon={Calendar}
            label="Последняя"
            value={
              localMeetings[0]
                ? formatMskDateTime(localMeetings[0].createdAt)
                : '—'
            }
          />
        </div>
      )}

      {/* Meeting list */}
      {localMeetings.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <TelemostIcon className="size-10 opacity-60" />
            <div className="space-y-1">
              <p className="font-medium">Встреч ещё нет</p>
              <p className="text-sm text-muted-foreground">
                Нажмите «Новая встреча» или запустите видеозвонок из любого
                диалога.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">История встреч</CardTitle>
            <CardDescription>
              Последние {localMeetings.length} видеовстреч (самые новые
              сверху).
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ul>
              {localMeetings.map((m, i) => (
                <li key={m.id}>
                  {i > 0 && <Separator />}
                  <MeetingRow
                    meeting={m}
                    copied={copiedId === m.id}
                    onCopy={() => copyLink(m.id, m.joinUrl)}
                  />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------------- */

function MeetingRow({
  meeting,
  copied,
  onCopy,
}: {
  meeting: TelemostMeetingRecord
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-6 py-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {/* Contact or standalone label */}
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">
            {meeting.contactName ?? 'Отдельная встреча'}
          </span>
          {meeting.delivered ? (
            <Badge variant="secondary" className="shrink-0 text-xs">
              <Check className="mr-1 size-3" />
              Отправлено клиенту
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="shrink-0 text-xs text-muted-foreground"
            >
              Не отправлялось
            </Badge>
          )}
        </div>

        {/* Join URL */}
        <a
          href={meeting.joinUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          <ExternalLink className="size-3 shrink-0" />
          <span className="truncate">{meeting.joinUrl}</span>
        </a>

        {/* Timestamp */}
        <span className="text-xs text-muted-foreground">
          {formatMskDateTime(meeting.createdAt)}
          {meeting.conversationId
            ? ' · через диалог'
            : ' · создана вручную'}
        </span>
      </div>

      {/* Copy button */}
      <Button
        variant="ghost"
        size="icon"
        className="mt-0.5 size-8 shrink-0"
        onClick={onCopy}
        aria-label="Скопировать ссылку"
        title="Скопировать ссылку на встречу"
      >
        {copied ? (
          <Check className="size-4 text-green-600" />
        ) : (
          <Copy className="size-4" />
        )}
      </Button>
    </div>
  )
}

/* ---------------------------------------------------------------------- */

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Video
  label: string
  value: string | number
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">{label}</p>
          <p className="truncate text-sm font-semibold">{value}</p>
        </div>
      </CardContent>
    </Card>
  )
}
