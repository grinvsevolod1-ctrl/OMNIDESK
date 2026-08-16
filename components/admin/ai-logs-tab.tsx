'use client'

import { useState } from 'react'
import useSWR from 'swr'
import {
  AlertTriangle,
  CheckCircle2,
  Pause,
  Play,
  Trash2,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  aiClearLogsAction,
  aiDiagnosticsAction,
  aiLogsAction,
  type AiDiagnostics,
} from '@/app/actions/ai-assist'
import type { AiLogLevel, AiLogRow } from '@/lib/data/ai-log'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const POLL_MS = 2500

const LEVEL_OPTIONS: { value: AiLogLevel | 'all'; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'debug', label: 'Debug и выше' },
  { value: 'info', label: 'Info и выше' },
  { value: 'warn', label: 'Warn и выше' },
  { value: 'error', label: 'Только ошибки' },
]

const SOURCE_LABEL: Record<string, string> = {
  brain: 'Модель',
  'ai-lead': 'ИИ-ведение',
  handoff: 'Передача',
  worker: 'Воркер',
  ai: 'ИИ',
}

function levelClasses(level: AiLogLevel): string {
  switch (level) {
    case 'error':
      return 'border-l-red-500 bg-red-500/5'
    case 'warn':
      return 'border-l-amber-500 bg-amber-500/5'
    case 'info':
      return 'border-l-emerald-500 bg-emerald-500/5'
    default:
      return 'border-l-border bg-transparent'
  }
}

function levelBadgeClasses(level: AiLogLevel): string {
  switch (level) {
    case 'error':
      return 'bg-red-500/15 text-red-600 dark:text-red-400'
    case 'warn':
      return 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
    case 'info':
      return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return ''
  }
}

export function AiLogsTab() {
  const [level, setLevel] = useState<AiLogLevel | 'all'>('all')
  const [live, setLive] = useState(true)

  // Log tail — SWR polls on an interval while "live"; pausing stops the poll.
  // A full tail (newest-first, capped server-side) keeps the client simple and
  // always consistent with the server ring buffer.
  const { data: logs = [], mutate: mutateLogs } = useSWR<AiLogRow[]>(
    ['ai-logs', level],
    () => aiLogsAction({ level, limit: 300 }),
    {
      refreshInterval: live ? POLL_MS : 0,
      revalidateOnFocus: false,
      keepPreviousData: true,
    },
  )

  // Health snapshot — cheap, refreshed on the same cadence.
  const { data: diag = null } = useSWR<AiDiagnostics>(
    'ai-diagnostics',
    () => aiDiagnosticsAction(),
    {
      refreshInterval: live ? POLL_MS * 2 : 0,
      revalidateOnFocus: false,
    },
  )

  const clearLog = async () => {
    try {
      await aiClearLogsAction()
      await mutateLogs([], { revalidate: false })
      toast.success('Лог очищен')
    } catch {
      toast.error('Не удалось очистить лог')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <DiagnosticsBanner diag={diag} />

      <Card className="flex flex-col gap-0 overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block size-2 rounded-full ${
                live ? 'animate-pulse bg-emerald-500' : 'bg-muted-foreground'
              }`}
              aria-hidden
            />
            <p className="text-sm font-medium">
              {live ? 'Онлайн-логи' : 'Логи (пауза)'}
            </p>
            <Badge variant="secondary">{logs.length}</Badge>
          </div>

          <div className="flex items-center gap-2">
            <Select
              value={level}
              onValueChange={(v) => setLevel((v as AiLogLevel | 'all') ?? 'all')}
            >
              <SelectTrigger className="h-8 w-40 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEVEL_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              size="sm"
              onClick={() => setLive((v) => !v)}
            >
              {live ? (
                <>
                  <Pause className="size-4" />
                  Пауза
                </>
              ) : (
                <>
                  <Play className="size-4" />
                  Возобновить
                </>
              )}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={clearLog}
              aria-label="Очистить лог"
              title="Очистить лог"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>

        <div className="flex max-h-[34rem] flex-col divide-y divide-border/60 overflow-y-auto">
          {logs.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              Пока нет событий. Как только ИИ-менеджер начнёт обрабатывать
              входящие сообщения клиентов, здесь появятся записи в реальном
              времени.
            </p>
          ) : (
            logs.map((l) => <LogLine key={l.id} log={l} />)
          )}
        </div>
      </Card>
    </div>
  )
}

function LogLine({ log }: { log: AiLogRow }) {
  const src = SOURCE_LABEL[log.source] ?? log.source
  return (
    <div
      className={`flex flex-col gap-1 border-l-2 px-3 py-2 ${levelClasses(log.level)}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">
          {formatTime(log.createdAt)}
        </span>
        <Badge
          className={`px-1.5 py-0 text-[10px] uppercase ${levelBadgeClasses(log.level)}`}
        >
          {log.level}
        </Badge>
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {src}
        </Badge>
        {log.channelType ? (
          <span className="text-xs text-muted-foreground">
            {log.channelType}
          </span>
        ) : null}
        <span className="font-mono text-[10px] text-muted-foreground/70">
          {log.event}
        </span>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
        {log.message}
      </p>
    </div>
  )
}

function DiagnosticsBanner({ diag }: { diag: AiDiagnostics | null }) {
  if (!diag) return null

  const problems: string[] = []
  if (!diag.aiConfigured)
    problems.push(
      'Не задан AI_GATEWAY_API_KEY — ИИ не может генерировать ответы.',
    )
  if (!diag.aiMasterEnabled)
    problems.push(
      'Главный выключатель ИИ выключен — авто-ответы не отправляются.',
    )

  const healthy = problems.length === 0

  return (
    <Card
      className={`flex flex-col gap-3 p-4 ${
        healthy
          ? 'border-emerald-500/40 bg-emerald-500/5'
          : 'border-amber-500/40 bg-amber-500/5'
      }`}
    >
      <div className="flex items-center gap-2">
        {healthy ? (
          <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <AlertTriangle className="size-5 text-amber-600 dark:text-amber-400" />
        )}
        <p className="font-medium">
          {healthy
            ? 'ИИ-менеджер настроен корректно.'
            : 'Обнаружены причины, по которым ИИ-менеджер может молчать:'}
        </p>
      </div>

      {!healthy ? (
        <ul className="ml-1 flex list-inside list-disc flex-col gap-1 text-sm text-amber-700 dark:text-amber-300">
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap gap-2 text-xs">
        <StatusChip ok={diag.aiConfigured} label="Ключ AI Gateway" />
        <StatusChip ok={diag.aiMasterEnabled} label="Главный выключатель ИИ" />
      </div>
    </Card>
  )
}

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge
      variant="outline"
      className={`gap-1 ${
        ok
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-red-600 dark:text-red-400'
      }`}
    >
      {ok ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
      {label}
    </Badge>
  )
}
