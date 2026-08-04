'use client'

/**
 * Feed atoms for the OMNIDESK OS shell: message bubbles, receipt chips, the
 * confirmation card for guarded actions, and the report download button.
 */

import { Check, FileDown, ShieldAlert, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type {
  AssistantReport,
  ExecutedAction,
  PendingConfirmation,
} from '@/lib/admin-console/assistant'
import type { ShellInsight } from '@/lib/admin-console/insights'
import type { ShellMessage } from './chat-types'
import { DataViewPanel } from './data-views'

export function ShellMessageRow({
  message,
  onConfirm,
  onCancelPending,
  confirmBusy,
}: {
  message: ShellMessage
  onConfirm: (pending: PendingConfirmation) => void
  onCancelPending: (messageId: string) => void
  confirmBusy: boolean
}) {
  const isUser = message.role === 'user'
  return (
    <div
      className={cn(
        'flex flex-col gap-2 duration-300 animate-in fade-in slide-in-from-bottom-2',
        isUser ? 'items-end' : 'items-start',
      )}
    >
      <div
        className={cn(
          'max-w-[92%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed sm:max-w-[80%]',
          isUser
            ? 'rounded-tr-sm bg-primary text-primary-foreground'
            : 'rounded-tl-sm border border-border bg-card/70 text-foreground backdrop-blur-sm',
        )}
      >
        {message.content ? (
          <p className="whitespace-pre-wrap text-pretty">
            {message.content}
            {message.streaming ? (
              <span className="ml-0.5 inline-block h-4 w-0.5 -translate-y-px animate-pulse bg-foreground/70 align-middle" />
            ) : null}
          </p>
        ) : message.streaming ? (
          <span className="flex gap-1 py-1" aria-label="Печатает">
            <Dot delay="0ms" />
            <Dot delay="150ms" />
            <Dot delay="300ms" />
          </span>
        ) : null}
      </div>

      {!isUser && message.actions && message.actions.length > 0 ? (
        <Receipts actions={message.actions} />
      ) : null}

      {!isUser && message.views && message.views.length > 0 ? (
        <div className="flex w-full max-w-[92%] flex-col gap-2 sm:max-w-[85%]">
          {message.views.map((v, i) => (
            <DataViewPanel key={i} view={v} />
          ))}
        </div>
      ) : null}

      {!isUser && message.report ? <ReportButton report={message.report} /> : null}

      {!isUser && message.pending ? (
        <ConfirmCard
          pending={message.pending}
          busy={confirmBusy}
          onConfirm={() => onConfirm(message.pending as PendingConfirmation)}
          onCancel={() => onCancelPending(message.id)}
        />
      ) : null}
    </div>
  )
}

/* ----------------------------- receipts ----------------------------- */

function Receipts({ actions }: { actions: ExecutedAction[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {actions.map((a, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
        >
          <Check className="size-3.5" />
          {a.label}
        </span>
      ))}
    </div>
  )
}

/* -------------------------- confirmation card ------------------------ */

/**
 * Two-phase safety gate: the copilot proposes, the admin disposes. Nothing
 * dangerous executes until this explicit click.
 */
function ConfirmCard({
  pending,
  busy,
  onConfirm,
  onCancel,
}: {
  pending: PendingConfirmation
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="w-full max-w-[92%] rounded-xl border border-destructive/40 bg-destructive/10 p-3.5 sm:max-w-[70%]">
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-foreground">{pending.label}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {pending.detail}
          </p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'Выполняю…' : 'Подтвердить'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          <X className="size-4" />
          Отмена
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------ report ------------------------------ */

function ReportButton({ report }: { report: AssistantReport }) {
  const download = () => {
    try {
      const blob = new Blob([report.content], { type: report.mimeType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = report.filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch {
      toast.error('Не удалось сформировать файл')
    }
  }
  return (
    <Button type="button" variant="outline" size="sm" onClick={download} className="gap-2">
      <FileDown className="size-4" />
      {`Скачать: ${report.label}`}
    </Button>
  )
}

/* ------------------------------- misc ------------------------------- */

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
      style={{ animationDelay: delay }}
    />
  )
}

/**
 * Hero shown before the first exchange. When the anomaly detector found
 * problems, the copilot leads with them («я нашёл проблему — разберём?»)
 * instead of a bland greeting; each insight is clickable and turns into a
 * command.
 */
export function ShellHero({
  greeting,
  insights = [],
  onInsight,
}: {
  greeting: string
  insights?: ShellInsight[]
  onInsight?: (prompt: string) => void
}) {
  const hasProblems = insights.length > 0
  return (
    <div className="flex flex-col items-center gap-4 py-10 text-center duration-500 animate-in fade-in">
      <span
        className={cn(
          'flex size-14 items-center justify-center rounded-2xl border',
          hasProblems
            ? 'border-warning/40 bg-warning/10 text-warning'
            : 'border-primary/30 bg-primary/10 text-primary',
        )}
      >
        {hasProblems ? (
          <ShieldAlert className="size-7" />
        ) : (
          <Sparkles className="size-7" />
        )}
      </span>
      <h2 className="max-w-lg text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
        OMNIDESK OS
      </h2>
      <p className="max-w-md text-sm leading-relaxed text-pretty text-muted-foreground">
        {hasProblems
          ? `Я проверил систему и нашёл ${insights.length === 1 ? 'проблему' : 'проблемы'}. Разберём?`
          : greeting}
      </p>

      {hasProblems ? (
        <ul className="flex w-full max-w-md flex-col gap-2 text-left">
          {insights.map((ins, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => onInsight?.(ins.prompt)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm transition-colors',
                  ins.level === 'problem'
                    ? 'border-destructive/40 bg-destructive/10 text-foreground hover:bg-destructive/20'
                    : ins.level === 'warning'
                      ? 'border-warning/40 bg-warning/10 text-foreground hover:bg-warning/20'
                      : 'border-border bg-card/50 text-muted-foreground hover:bg-card',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    ins.level === 'problem'
                      ? 'bg-destructive'
                      : ins.level === 'warning'
                        ? 'bg-warning'
                        : 'bg-muted-foreground',
                  )}
                />
                <span className="flex-1 text-pretty">{ins.text}</span>
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  Разобрать
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
