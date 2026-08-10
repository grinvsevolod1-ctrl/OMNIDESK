'use client'

/**
 * Feed atoms for the OMNIDESK OS shell: message bubbles, receipt chips, the
 * confirmation card for guarded actions, and the report download button.
 */

import { Check, Command, FileDown, ShieldAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  onCommand,
}: {
  message: ShellMessage
  onConfirm: (pending: PendingConfirmation) => void
  onCancelPending: (messageId: string) => void
  confirmBusy: boolean
  /** Row clicks in data panels issue follow-up commands through this. */
  onCommand?: (prompt: string) => void
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
            ? 'rounded-tr-sm bg-primary text-primary-foreground shadow-[0_2px_12px_rgb(0_0_0/0.25)]'
            : 'od-glass rounded-tl-sm text-foreground',
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
          message.status ? (
            // Tool progress («Ищу диалоги…») — live region so screen readers
            // hear what the copilot is busy with.
            <span
              className="flex items-center gap-2 py-1 text-muted-foreground"
              role="status"
            >
              <span className="flex gap-1" aria-hidden="true">
                <Dot delay="0ms" />
                <Dot delay="150ms" />
                <Dot delay="300ms" />
              </span>
              {message.status}
            </span>
          ) : (
            <span className="flex gap-1 py-1" aria-label="Печатает">
              <Dot delay="0ms" />
              <Dot delay="150ms" />
              <Dot delay="300ms" />
            </span>
          )
        ) : null}
      </div>

      {!isUser && message.actions && message.actions.length > 0 ? (
        <Receipts actions={message.actions} />
      ) : null}

      {!isUser && message.views && message.views.length > 0 ? (
        <div className="flex w-full max-w-[92%] flex-col gap-2 sm:max-w-[85%]">
          {message.views.map((v, i) => (
            <DataViewPanel key={i} view={v} onCommand={onCommand} />
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

/* -------------------------- confirmation modal ----------------------- */

/**
 * Two-phase safety gate: the copilot proposes, the admin disposes. Nothing
 * dangerous executes until this explicit click. Rendered as a MODAL dialog —
 * the decision demands full attention and must not scroll away with the feed.
 * Dismissing the dialog (Esc / overlay click) counts as cancel.
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-destructive/40 bg-destructive/10">
            <ShieldAlert className="size-6 text-destructive" />
          </div>
          <DialogTitle className="text-center text-balance">
            {pending.label}
          </DialogTitle>
          <DialogDescription className="text-center text-pretty leading-relaxed">
            {pending.detail}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-center">
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            <X className="size-4" />
            Отмена
          </Button>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy ? 'Выполняю…' : 'Подтвердить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------ report ------------------------------ */

function ReportButton({ report }: { report: AssistantReport }) {
  const download = () => {
    try {
      // UTF-8 BOM for CSV: without it Excel assumes a legacy codepage
      // (Windows-1251) and renders Cyrillic as mojibake («битые символы»).
      const isCsv =
        report.mimeType.includes('csv') || report.filename.endsWith('.csv')
      const parts: BlobPart[] = isCsv
        ? ['\uFEFF', report.content]
        : [report.content]
      const blob = new Blob(parts, {
        type: isCsv ? 'text/csv;charset=utf-8' : report.mimeType,
      })
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
 * Hero shown before the first exchange — big, laconic, Apple-scale. When the
 * anomaly detector found problems, the copilot leads with them («я нашёл
 * проблему — разберём?»); each insight is clickable and turns into a command,
 * and «Скрыть» mutes the findings until tomorrow.
 */
export function ShellHero({
  greeting,
  insights = [],
  onInsight,
  onDismissInsights,
}: {
  greeting: string
  insights?: ShellInsight[]
  onInsight?: (prompt: string) => void
  onDismissInsights?: () => void
}) {
  const hasProblems = insights.length > 0
  return (
    <div className="flex flex-col items-center gap-6 py-14 text-center sm:py-20">
      <span
        className={cn(
          'od-rise od-rise-1 od-glass flex size-16 items-center justify-center rounded-3xl sm:size-20',
          hasProblems ? 'text-warning' : 'text-foreground',
        )}
      >
        {hasProblems ? (
          <ShieldAlert className="size-8 sm:size-10" />
        ) : (
          <Command className="size-8 sm:size-10" />
        )}
      </span>
      <h2 className="od-rise od-rise-2 od-hero-title max-w-2xl text-5xl font-semibold tracking-tighter text-balance sm:text-7xl">
        OMNIDESK OS
      </h2>
      <p className="od-rise od-rise-3 max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
        {hasProblems
          ? `Я проверил систему и нашёл ${insights.length === 1 ? 'проблему' : 'проблемы'}. Разберём?`
          : greeting}
      </p>

      {hasProblems ? (
        <div className="od-rise od-rise-4 flex w-full max-w-lg flex-col gap-2.5">
          <ul className="flex w-full flex-col gap-2.5 text-left">
            {insights.map((ins, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => onInsight?.(ins.prompt)}
                  className={cn(
                    'press-scale flex w-full items-center gap-3 rounded-2xl border px-5 py-4 text-base transition-colors',
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
                      'size-2.5 shrink-0 rounded-full',
                      ins.level === 'problem'
                        ? 'bg-destructive'
                        : ins.level === 'warning'
                          ? 'bg-warning'
                          : 'bg-muted-foreground',
                    )}
                  />
                  <span className="flex-1 text-pretty">{ins.text}</span>
                  <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Разобрать
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={onDismissInsights}
            className="self-center rounded-full px-4 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Скрыть до завтра
          </button>
        </div>
      ) : null}
    </div>
  )
}
