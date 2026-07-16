'use client'

import { useMemo, useState, useTransition } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import {
  ArrowDownLeft,
  ArrowUpRight,
  GraduationCap,
  Loader2,
  MessagesSquare,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import {
  simAddCorrectionAction,
  simDeleteCorrectionAction,
  simDialogForReviewAction,
  simListAdoptableAction,
  simListCorrectionsAction,
} from '@/app/actions/client-sim'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { AdoptableConversation, SimCorrection, SimReviewMessage } from '@/lib/client-sim/store'

/**
 * Simulator training panel — the secret-panel mirror of the AI manager's
 * corrections. The admin picks one of the simulator's OWN dialogs, taps the
 * message the fake client got wrong, and writes what a real person would do
 * instead. The rule is injected into every future simulator generation.
 *
 * Note: the dialog list comes from {@link simListAdoptableAction}, which is
 * already scoped to simulated dialogs only — a real person's chat can never
 * appear here.
 */
export function SecretSimulatorTrain() {
  const [openConvId, setOpenConvId] = useState<string | null>(null)

  const {
    data: dialogs = [],
    error: listError,
    isLoading: listLoading,
    mutate: mutateList,
  } = useSWR<AdoptableConversation[]>('sim-train-dialogs', () => simListAdoptableAction(), {
    revalidateOnFocus: false,
  })

  const {
    data: corr = { items: [], total: 0 },
    mutate: mutateCorr,
  } = useSWR('sim-corrections', () => simListCorrectionsAction(), {
    revalidateOnFocus: false,
  })

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40 text-foreground">
            <GraduationCap className="size-5" />
          </div>
          <div>
            <h3 className="font-semibold tracking-tight">Обучение симулятора</h3>
            <p className="max-w-prose text-sm text-muted-foreground text-pretty">
              Откройте диалог симулятора, отметьте сообщение, где «клиент» повёл
              себя не по-человечески, и напишите правило — как надо. Правило
              применяется ко всем будущим репликам симулятора. Это отдельная база
              от обучения ИИ-менеджера.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => void mutateList()}
          disabled={listLoading}
        >
          <RefreshCw className={cn('size-4', listLoading && 'animate-spin')} />
          Обновить
        </Button>
      </div>

      {listError ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          <TriangleAlert className="size-4 shrink-0" />
          Не удалось загрузить диалоги симулятора.
        </div>
      ) : null}

      {/* Dialog picker */}
      {dialogs.length === 0 && !listLoading ? (
        <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          Пока нет диалогов симулятора. Запустите симулятор — и здесь появятся
          переписки, которые можно разбирать.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg border border-border">
          {dialogs.slice(0, 40).map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setOpenConvId((cur) => (cur === d.id ? null : d.id))}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40',
                openConvId === d.id && 'bg-muted/50',
              )}
            >
              <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {d.contactName || 'Без имени'}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {d.lastMessage || '—'}
                </p>
              </div>
              <Badge variant="secondary" className="shrink-0 tabular-nums">
                {d.messageCount}
              </Badge>
            </button>
          ))}
        </div>
      )}

      {/* Review + correction pane */}
      {openConvId ? (
        <ReviewPane
          conversationId={openConvId}
          onSaved={() => {
            void mutateCorr()
          }}
        />
      ) : null}

      {/* Existing rules */}
      <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">
            Правила симулятора{' '}
            <span className="text-muted-foreground tabular-nums">({corr.total})</span>
          </h4>
        </div>
        {corr.items.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Пока нет правил. Разберите диалог выше, чтобы добавить первое.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {corr.items.map((c) => (
              <RuleRow
                key={c.id}
                rule={c}
                onDeleted={() => {
                  void mutateCorr()
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

/* ------------------------------- review --------------------------------- */

function ReviewPane({
  conversationId,
  onSaved,
}: {
  conversationId: string
  onSaved: () => void
}) {
  const [pending, startTransition] = useTransition()
  const [targetId, setTargetId] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')

  const { data: messages = [], isLoading } = useSWR<SimReviewMessage[]>(
    ['sim-review', conversationId],
    () => simDialogForReviewAction(conversationId),
    { revalidateOnFocus: false },
  )

  const target = useMemo(
    () => messages.find((m) => m.id === targetId) ?? null,
    [messages, targetId],
  )

  /** Two turns before the target + the target — enough situational context. */
  function buildContext(): string {
    const idx = messages.findIndex((m) => m.id === targetId)
    if (idx < 0) return ''
    const from = Math.max(0, idx - 3)
    return messages
      .slice(from, idx + 1)
      .map((m) => `${m.role === 'sim' ? 'Клиент(симулятор)' : 'Менеджер'}: ${m.body}`)
      .join('\n')
  }

  function save() {
    if (!target) {
      toast.error('Выберите сообщение симулятора для разбора.')
      return
    }
    const rule = instruction.trim()
    if (!rule) {
      toast.error('Опишите, что не так и как надо.')
      return
    }
    startTransition(async () => {
      try {
        await simAddCorrectionAction({
          conversationId,
          context: buildContext(),
          targetMessage: target.body,
          instruction: rule,
        })
        toast.success('Правило добавлено — применяется ко всем будущим репликам.')
        setInstruction('')
        setTargetId(null)
        onSaved()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Не удалось сохранить правило')
      }
    })
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3">
      {isLoading ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Загружаю переписку…
        </div>
      ) : (
        <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
          {messages.map((m) => {
            const isSim = m.role === 'sim'
            const selectable = isSim
            const selected = m.id === targetId
            return (
              <button
                key={m.id}
                type="button"
                disabled={!selectable}
                onClick={() => selectable && setTargetId(selected ? null : m.id)}
                className={cn(
                  'flex items-start gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                  isSim
                    ? 'bg-background'
                    : 'bg-primary/10 text-foreground',
                  selectable && 'hover:ring-1 hover:ring-border cursor-pointer',
                  selected && 'ring-2 ring-primary',
                  !selectable && 'cursor-default',
                )}
              >
                {isSim ? (
                  <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ArrowDownLeft className="mt-0.5 size-3.5 shrink-0 text-primary" />
                )}
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                  {m.body || '—'}
                </span>
              </button>
            )
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Нажмите на сообщение <span className="font-medium">клиента (симулятора)</span>,
        которое нужно разобрать.
      </p>

      {target ? (
        <div className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <p className="text-xs text-muted-foreground">Разбираем сообщение:</p>
          <p className="text-sm">«{target.body}»</p>
          <Textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Что не так и как надо. Напр.: «Не пиши „доброе утро“ вечером — здоровайся по времени суток» или «Не противоречь своему возрасту, ты уже сказал что тебе 34»."
            rows={3}
            className="resize-none text-sm"
          />
          <div className="flex justify-end">
            <Button size="sm" className="gap-2" onClick={save} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <GraduationCap className="size-4" />}
              Добавить правило
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------- rule row ------------------------------- */

function RuleRow({ rule, onDeleted }: { rule: SimCorrection; onDeleted: () => void }) {
  const [pending, startTransition] = useTransition()

  function remove() {
    startTransition(async () => {
      try {
        await simDeleteCorrectionAction(rule.id)
        onDeleted()
      } catch {
        toast.error('Не удалось удалить правило')
      }
    })
  }

  return (
    <li className="flex items-start gap-2 rounded-lg border border-border bg-background p-3">
      <div className="min-w-0 flex-1">
        {rule.targetMessage ? (
          <p className="truncate text-xs text-muted-foreground">
            «{rule.targetMessage}»
          </p>
        ) : null}
        <p className="text-sm">{rule.instruction}</p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={remove}
        disabled={pending}
        aria-label="Удалить правило"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
      </Button>
    </li>
  )
}
