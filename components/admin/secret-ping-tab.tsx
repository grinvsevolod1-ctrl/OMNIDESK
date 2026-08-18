'use client'

/**
 * God-панель, вкладка «Ping» — проверка доступности своего домена/URL.
 *
 * Владелец вводит адрес, панель делает несколько HTTP-запросов и показывает
 * статус-код и задержку каждой попытки + сводку (min/avg/max, потери).
 * Часть скрытой панели: подчиняется инвариантам AGENTS.md §4 (обычная
 * админка и Admin AI о вкладке не знают, сервер-экшен не пишет в audit).
 *
 * Это простой uptime-чекер: читаются только статус-код и время ответа.
 */

import { useState } from 'react'
import { toast } from 'sonner'
import {
  Activity,
  ArrowRight,
  CircleAlert,
  CircleCheck,
  Gauge,
  Loader2,
  Radio,
} from 'lucide-react'
import {
  secretPingAction,
  type PingResult,
} from '@/app/actions/admin-secret'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const ATTEMPT_OPTIONS = [1, 2, 4, 6]

export function SecretPingTab() {
  const [url, setUrl] = useState('')
  const [attempts, setAttempts] = useState(4)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<PingResult | null>(null)

  async function runPing() {
    const target = url.trim()
    if (!target) {
      toast.error('Введите домен или URL')
      return
    }
    setPending(true)
    setResult(null)
    try {
      const res = await secretPingAction(target, attempts)
      if (res.ok && res.data) {
        setResult(res.data)
        if (res.data.received === 0) toast.error(res.message)
      } else {
        toast.error(res.message)
      }
    } catch {
      toast.error('Внутренняя ошибка при проверке')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* ---- Ввод адреса ---- */}
      <div className="rounded-xl border border-border bg-card/40 p-4 md:p-5">
        <div className="mb-4 flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Radio className="size-4" />
          Проверка доступности
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Activity className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.nativeEvent.isComposing &&
                  e.keyCode !== 229 &&
                  !pending
                ) {
                  void runPing()
                }
              }}
              placeholder="example.com или https://example.com/health"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="pl-9 font-mono text-sm"
              aria-label="Домен или URL для проверки"
            />
          </div>

          <Button
            onClick={() => void runPing()}
            disabled={pending}
            className="press-scale gap-1.5"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowRight className="size-4" />
            )}
            Проверить
          </Button>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Попыток:</span>
          {ATTEMPT_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setAttempts(n)}
              className={cn(
                'press-scale rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                attempts === n
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* ---- Результат ---- */}
      {result && <PingReport result={result} />}

      {!result && !pending && (
        <p className="px-1 text-sm text-muted-foreground">
          Введите свой домен или адрес страницы состояния — панель измерит
          HTTP-статус и время ответа за несколько попыток.
        </p>
      )}
    </div>
  )
}

function PingReport({ result }: { result: PingResult }) {
  const allLost = result.received === 0

  return (
    <div className="flex flex-col gap-4">
      {/* Заголовок хоста */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-sm font-medium text-foreground">
          {result.host}
        </span>
        {result.ip && (
          <span className="font-mono text-xs text-muted-foreground">
            {result.ip}
          </span>
        )}
      </div>

      {/* Сводка */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={CircleCheck}
          label="Получено"
          value={`${result.received}/${result.attempts.length}`}
          tone={allLost ? 'bad' : 'good'}
        />
        <StatCard
          icon={CircleAlert}
          label="Потеряно"
          value={String(result.lost)}
          tone={result.lost > 0 ? 'bad' : 'muted'}
        />
        <StatCard
          icon={Gauge}
          label="Средняя"
          value={result.avg !== null ? `${result.avg} мс` : '—'}
          tone="muted"
        />
        <StatCard
          icon={Gauge}
          label="Мин / Макс"
          value={
            result.min !== null && result.max !== null
              ? `${result.min} / ${result.max}`
              : '—'
          }
          tone="muted"
        />
      </div>

      {/* Попытки */}
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">#</th>
              <th className="px-4 py-2 font-medium">Статус</th>
              <th className="px-4 py-2 font-medium">Задержка</th>
              <th className="px-4 py-2 font-medium">Результат</th>
            </tr>
          </thead>
          <tbody>
            {result.attempts.map((a) => (
              <tr
                key={a.seq}
                className="border-b border-border/60 last:border-b-0"
              >
                <td className="px-4 py-2 font-mono text-muted-foreground">
                  {a.seq}
                </td>
                <td className="px-4 py-2 font-mono">
                  {a.status !== null ? (
                    <StatusBadge status={a.status} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-4 py-2 font-mono">
                  {a.ms !== null ? (
                    `${a.ms} мс`
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  {a.ms !== null ? (
                    <span className="inline-flex items-center gap-1.5 text-emerald-500">
                      <CircleCheck className="size-3.5" />
                      OK
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-destructive">
                      <CircleAlert className="size-3.5" />
                      {a.error ?? 'Ошибка'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Gauge
  label: string
  value: string
  tone: 'good' | 'bad' | 'muted'
}) {
  return (
    <div className="rounded-xl border border-border bg-card/40 p-3">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div
        className={cn(
          'text-lg font-semibold tracking-tight',
          tone === 'good' && 'text-emerald-500',
          tone === 'bad' && 'text-destructive',
          tone === 'muted' && 'text-foreground',
        )}
      >
        {value}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: number }) {
  const tone =
    status >= 200 && status < 300
      ? 'text-emerald-500'
      : status >= 300 && status < 400
        ? 'text-amber-500'
        : 'text-destructive'
  return <span className={tone}>{status}</span>
}
