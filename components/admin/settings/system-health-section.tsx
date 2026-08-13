import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Gauge,
  Inbox,
  MailWarning,
  ScrollText,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { getSystemHealth } from '@/lib/data/ai-health'
import { getHealthMetrics } from '@/lib/data/health-metrics'

/**
 * "Здоровье системы" card for admin settings. Server component: renders a
 * point-in-time snapshot on page load — settings is a low-traffic page, so a
 * refresh-on-navigation model beats a polling dashboard here.
 */

function fmtMs(ms: number | null): string {
  if (ms == null) return '—'
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} с`
  return `${ms} мс`
}

function fmtAge(sec: number | null): string {
  if (sec == null) return '—'
  if (sec < 60) return `${sec} с`
  if (sec < 3600) return `${Math.round(sec / 60)} мин`
  return `${(sec / 3600).toFixed(1)} ч`
}

type Tone = 'ok' | 'warn' | 'bad'

function StatChip({
  tone,
  label,
  value,
  hint,
  icon: Icon,
}: {
  tone: Tone
  label: string
  value: string
  hint?: string
  icon: React.ComponentType<{ className?: string }>
}) {
  const toneClasses: Record<Tone, string> = {
    ok: 'border-border bg-muted/30',
    warn: 'border-amber-500/40 bg-amber-500/5',
    bad: 'border-destructive/40 bg-destructive/5',
  }
  const iconTone: Record<Tone, string> = {
    ok: 'text-muted-foreground',
    warn: 'text-amber-600 dark:text-amber-500',
    bad: 'text-destructive',
  }
  return (
    <div
      className={`flex flex-col gap-1 rounded-lg border p-3 ${toneClasses[tone]}`}
    >
      <div className="flex items-center gap-1.5">
        <Icon className={`size-3.5 shrink-0 ${iconTone[tone]}`} />
        <span className="truncate text-xs text-muted-foreground">{label}</span>
      </div>
      <span className="text-lg font-semibold tabular-nums leading-tight">
        {value}
      </span>
      {hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  )
}

export async function SystemHealthSection({
  bare = false,
}: {
  /** Без собственного заголовка секции — имя даёт вкладка настроек. */
  bare?: boolean
} = {}) {
  const [health, metrics] = await Promise.all([
    getSystemHealth(),
    getHealthMetrics(),
  ])

  const { brain24h, deadLetters, queue } = metrics
  const okPct =
    brain24h.okRate == null ? null : Math.round(brain24h.okRate * 100)

  const brainTone: Tone =
    okPct == null ? 'ok' : okPct >= 97 ? 'ok' : okPct >= 90 ? 'warn' : 'bad'
  const p95Tone: Tone =
    brain24h.p95Ms == null
      ? 'ok'
      : brain24h.p95Ms <= 8000
        ? 'ok'
        : brain24h.p95Ms <= 20_000
          ? 'warn'
          : 'bad'
  const queueTone: Tone = !health.queue.workerLikelyAlive
    ? 'bad'
    : queue.queued > 50
      ? 'warn'
      : 'ok'
  const dlTone: Tone =
    deadLetters.exhausted7d > 0 ? 'bad' : deadLetters.pending > 0 ? 'warn' : 'ok'

  const downChannels = health.channels.filter(
    (c) => c.status !== 'active' || (c.sessionStatus && c.sessionStatus !== 'online'),
  )

  const overallOk =
    brainTone !== 'bad' &&
    p95Tone !== 'bad' &&
    queueTone !== 'bad' &&
    dlTone !== 'bad' &&
    health.gateway.ok

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {!bare ? (
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Здоровье системы
          </h2>
        ) : null}
        <Badge
          variant="outline"
          className={
            overallOk
              ? 'gap-1 border-emerald-500/40 bg-emerald-500/5 text-emerald-600 dark:text-emerald-500'
              : 'gap-1 border-amber-500/40 bg-amber-500/5 text-amber-600 dark:text-amber-500'
          }
        >
          {overallOk ? (
            <CheckCircle2 className="size-3" />
          ) : (
            <AlertTriangle className="size-3" />
          )}
          {overallOk ? 'В норме' : 'Требует внимания'}
        </Badge>
      </div>

      <Card className="flex flex-col gap-4 p-5">
        {/* Brain */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatChip
            tone={brainTone}
            icon={Activity}
            label="Ответы ИИ, 24ч"
            value={
              brain24h.calls === 0
                ? '0'
                : `${brain24h.calls}${okPct == null ? '' : ` · ${okPct}%`}`
            }
            hint={brain24h.calls === 0 ? 'нет вызовов' : 'вызовов · успех'}
          />
          <StatChip
            tone={p95Tone}
            icon={Gauge}
            label="Скорость p50 / p95"
            value={`${fmtMs(brain24h.p50Ms)} / ${fmtMs(brain24h.p95Ms)}`}
            hint="латентность мозга"
          />
          <StatChip
            tone={queueTone}
            icon={Inbox}
            label="Очередь воркера"
            value={String(queue.queued)}
            hint={
              !health.queue.workerLikelyAlive
                ? `воркер молчит ${fmtAge(queue.oldestQueuedSec)}`
                : queue.oldestQueuedSec != null
                  ? `старейшая ${fmtAge(queue.oldestQueuedSec)}`
                  : `за 24ч: ${queue.done24h} ок / ${queue.errored24h} ошибок`
            }
          />
          <StatChip
            tone={dlTone}
            icon={MailWarning}
            label="Недоставленные"
            value={String(deadLetters.pending)}
            hint={
              deadLetters.exhausted7d > 0
                ? `${deadLetters.exhausted7d} исчерпали попытки`
                : 'в очереди повторов'
            }
          />
        </div>

        {/* Failures breakdown, only when present */}
        {brain24h.failures.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <span className="text-xs text-muted-foreground">Сбои за 24ч:</span>
            {brain24h.failures.map((f) => (
              <Badge key={f.outcome} variant="outline" className="font-mono text-xs">
                {f.outcome}: {f.count}
              </Badge>
            ))}
          </div>
        ) : null}

        {/* Channels / gateway / audit footer */}
        <div className="flex flex-col gap-2 border-t border-border pt-3 text-sm sm:flex-row sm:items-center sm:gap-5">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Clock className="size-3.5" />
            Каналы:{' '}
            {downChannels.length === 0 ? (
              <span className="font-medium text-foreground">
                все {health.channels.length} в строю
              </span>
            ) : (
              <span className="font-medium text-destructive">
                {downChannels.length} из {health.channels.length} не в сети
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Gauge className="size-3.5" />
            AI Gateway:{' '}
            {health.gateway.ok && health.gateway.balanceUsd != null ? (
              <span className="font-medium text-foreground">
                ${health.gateway.balanceUsd.toFixed(2)}
              </span>
            ) : (
              <span className="font-medium text-amber-600 dark:text-amber-500">
                {health.gateway.note ?? 'недоступен'}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <ScrollText className="size-3.5" />
            Журнал: {metrics.auditWrites24h} записей за 24ч
          </span>
        </div>
      </Card>
    </section>
  )
}
