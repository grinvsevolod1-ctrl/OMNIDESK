'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Check, Copy, FileText, Loader2, RotateCcw, Send } from 'lucide-react'
import { secretGenerateReportAction } from '@/app/actions/admin-secret'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Markdown } from '@/components/admin/secret-markdown'

/**
 * «Сформировать отчёт» — AI report over the managed cabinets, chat-style.
 * The model may answer with a report OR with clarifying questions; the
 * operator replies in the same thread and the model keeps full context.
 * Assistant markdown (headings, tables, lists) is rendered properly.
 * Nothing is persisted (owner decision).
 *
 * SACRED INVARIANT (AGENTS.md §4): god-panel only.
 */

const QUICK_PROMPTS = [
  'Полный отчёт по всем кабинетам за 7 дней',
  'Отчёт за сегодня: расход, лиды, CPA',
  'Сравни кабинеты за месяц и найди слабые места',
  'Где деньги сгорают впустую?',
]

type Msg = { role: 'user' | 'assistant'; content: string }

export function ReportDialog({
  open,
  onOpenChange,
  siteId,
  siteTitle,
  sites,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** When set — report covers only this site; otherwise all sites. */
  siteId?: string
  siteTitle?: string
  /**
   * When provided (and no fixed siteId), the operator can narrow the report
   * to specific cabinets via toggle chips. Default = all selected.
   */
  sites?: { id: string; title: string }[]
}) {
  const [pending, startTransition] = useTransition()
  const [thread, setThread] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  // Deselected cabinet ids — inverted so newly appearing sites are included
  // by default without any state sync.
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)

  const selectable = !siteId && (sites?.length ?? 0) > 1
  const selectedCount = selectable
    ? (sites?.length ?? 0) - excluded.size
    : sites?.length ?? 0

  function toggleSite(id: string) {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else if (next.size < (sites?.length ?? 0) - 1) next.add(id)
      // Refuse to exclude the LAST remaining cabinet — an empty selection
      // would silently mean «все кабинеты», the opposite of the intent.
      return next
    })
  }

  function selectedIds(): string[] | undefined {
    if (siteId) return [siteId]
    if (!selectable || excluded.size === 0) return undefined
    return (sites ?? []).filter((s) => !excluded.has(s.id)).map((s) => s.id)
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [thread, pending])

  function send(text: string) {
    const content = text.trim()
    if (!content || pending) return
    const next: Msg[] = [...thread, { role: 'user', content }]
    setThread(next)
    setInput('')
    startTransition(async () => {
      try {
        const res = await secretGenerateReportAction(
          next,
          siteId ? [siteId] : undefined,
        )
        if (res.ok && res.report) {
          setThread([...next, { role: 'assistant', content: res.report }])
        } else {
          toast.error(res.message)
          setThread(thread) // откат — запрос можно поправить и повторить
          setInput(content)
        }
      } catch {
        toast.error('Внутренняя ошибка сервера')
        setThread(thread)
        setInput(content)
      }
    })
  }

  function reset(v: boolean) {
    onOpenChange(v)
    if (!v) {
      setThread([])
      setInput('')
    }
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <FileText className="size-5" />
            AI-отчёт{siteTitle ? ` — ${siteTitle}` : ' по всем кабинетам'}
          </DialogTitle>
          <DialogDescription>
            Опишите, какой отчёт нужен. Если запрос неоднозначный — ассистент
            задаст уточняющие вопросы, отвечайте прямо в этом окне.
          </DialogDescription>
        </DialogHeader>

        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
        >
          {thread.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-sm text-muted-foreground text-pretty">
                Например: «полный отчёт за неделю», «сколько потратили сегодня и
                на что», «сравни кабинеты за месяц»
              </p>
              <div className="flex max-w-md flex-wrap justify-center gap-1.5">
                {QUICK_PROMPTS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => send(p)}
                    className="rounded-full border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {thread.map((m, i) =>
                m.role === 'user' ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <AssistantMessage key={i} content={m.content} />
                ),
              )}
              {pending && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Формирую отчёт…
                </div>
              )}
            </div>
          )}
        </div>

        <div className="border-t px-6 py-4">
          <div className="flex items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  e.keyCode !== 229
                ) {
                  e.preventDefault()
                  send(input)
                }
              }}
              placeholder={
                thread.length === 0
                  ? 'Какой отчёт нужен?'
                  : 'Уточнение или новый вопрос…'
              }
              rows={2}
              maxLength={4000}
              className="min-h-0 resize-none"
            />
            <div className="flex flex-col gap-1.5">
              <Button
                size="icon"
                onClick={() => send(input)}
                disabled={pending || !input.trim()}
                aria-label="Отправить"
              >
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
              </Button>
              {thread.length > 0 && (
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => {
                    setThread([])
                    setInput('')
                  }}
                  disabled={pending}
                  aria-label="Начать заново"
                >
                  <RotateCcw className="size-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* --------------------------- Assistant message --------------------------- */

function AssistantMessage({ content }: { content: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Не удалось скопировать')
    }
  }

  return (
    <div className="group relative rounded-xl border bg-card px-5 py-4">
      <Markdown text={content} />
      <Button
        size="icon"
        variant="ghost"
        onClick={copy}
        className="absolute right-2 top-2 size-7 opacity-0 transition-opacity group-hover:opacity-100"
        aria-label="Скопировать отчёт"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  )
}


