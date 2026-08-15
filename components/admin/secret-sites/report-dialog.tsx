'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { FileText, Loader2, Copy, Check } from 'lucide-react'
import { secretGenerateReportAction } from '@/app/actions/admin-secret'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

/**
 * «Сформировать отчёт» — free-form AI report over the managed sites. The
 * operator types ANY request (period, focus, comparison, format); the server
 * action ships the FULL state of every site to the AI Gateway and returns an
 * analytical report. Result is shown in the dialog with one-click copy —
 * nothing is persisted (owner decision).
 *
 * SACRED INVARIANT (AGENTS.md §4): god-panel only.
 */

const QUICK_PROMPTS = [
  'Дневной отчёт по всем запущенным кабинетам',
  'Отчёт за последние 3 часа',
  'Сравни кабинеты за неделю',
  'Где самый дорогой CPA и что с этим делать?',
]

export function ReportDialog({
  open,
  onOpenChange,
  siteId,
  siteTitle,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** When set — report covers only this site; otherwise all sites. */
  siteId?: string
  siteTitle?: string
}) {
  const [pending, startTransition] = useTransition()
  const [request, setRequest] = useState('')
  const [report, setReport] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  function generate() {
    startTransition(async () => {
      try {
        const res = await secretGenerateReportAction(
          request,
          siteId ? [siteId] : undefined,
        )
        if (res.ok && res.report) {
          setReport(res.report)
          setModel(res.model ?? null)
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
    })
  }

  async function copyReport() {
    if (!report) return
    try {
      await navigator.clipboard.writeText(report)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast.success('Отчёт скопирован')
    } catch {
      toast.error('Не удалось скопировать')
    }
  }

  function reset(v: boolean) {
    onOpenChange(v)
    if (!v) {
      setReport(null)
      setModel(null)
      setCopied(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="size-5" />
            AI-отчёт{siteTitle ? ` — ${siteTitle}` : ' по всем кабинетам'}
          </DialogTitle>
          <DialogDescription>
            Опишите, какой отчёт нужен — период, фокус, формат. Модель получит
            полное состояние {siteTitle ? 'кабинета' : 'всех кабинетов'} и
            ответит по данным.
          </DialogDescription>
        </DialogHeader>

        {report === null ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="report-request">Запрос</Label>
              <Textarea
                id="report-request"
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                placeholder="Например: дневной отчёт по всем запущенным аккаунтам"
                rows={3}
                maxLength={2000}
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setRequest(p)}
                  className="rounded-full border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {p}
                </button>
              ))}
            </div>
            <Button onClick={generate} disabled={pending} className="gap-2">
              {pending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Формирую отчёт…
                </>
              ) : (
                'Сформировать отчёт'
              )}
            </Button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-3">
            <div className="min-h-0 overflow-y-auto rounded-lg border bg-muted/30 p-4">
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
                {report}
              </pre>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {model ? `Модель: ${model}` : ''}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setReport(null)
                    setCopied(false)
                  }}
                >
                  Новый запрос
                </Button>
                <Button onClick={copyReport} className="gap-2">
                  {copied ? (
                    <Check className="size-4" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                  Скопировать
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
