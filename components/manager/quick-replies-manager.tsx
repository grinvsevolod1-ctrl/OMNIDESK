'use client'

import { useRef, useState, useTransition } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  MessageSquareText,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  createQuickReplyAction,
  deleteQuickReplyAction,
  reorderQuickRepliesAction,
  updateQuickReplyAction,
} from '@/app/actions/quick-replies'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState } from '@/components/page-parts'
import { cn } from '@/lib/utils'
import type { QuickReply } from '@/lib/types'

const MAX_TITLE = 80
const MAX_BODY = 2000

/**
 * Auto-growing textarea used both in the editor here and (separately) in the
 * inbox composer. Resizes to fit its content between min/max rows so the
 * manager can read the full message while typing.
 */
function AutoTextarea({
  value,
  onChange,
  placeholder,
  maxLength,
  ariaLabel,
  autoFocus,
  onSubmitShortcut,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  maxLength?: number
  ariaLabel?: string
  autoFocus?: boolean
  onSubmitShortcut?: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  function resize(el: HTMLTextAreaElement | null) {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }

  return (
    <textarea
      ref={(el) => {
        ref.current = el
        resize(el)
      }}
      value={value}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      placeholder={placeholder}
      maxLength={maxLength}
      rows={2}
      onChange={(e) => {
        onChange(e.target.value)
        resize(e.target)
      }}
      onKeyDown={(e) => {
        if (
          onSubmitShortcut &&
          (e.metaKey || e.ctrlKey) &&
          e.key === 'Enter'
        ) {
          e.preventDefault()
          onSubmitShortcut()
        }
      }}
      className="min-h-[64px] w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
    />
  )
}

/** Inline editor for creating or editing a quick reply. */
function ReplyEditor({
  initialTitle = '',
  initialBody = '',
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialTitle?: string
  initialBody?: string
  busy: boolean
  submitLabel: string
  onSubmit: (title: string, body: string) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(initialTitle)
  const [body, setBody] = useState(initialBody)

  function submit() {
    if (!body.trim() || busy) return
    onSubmit(title.trim(), body.trim())
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="qr-title" className="text-xs text-muted-foreground">
          Название (необязательно)
        </Label>
        <Input
          id="qr-title"
          value={title}
          maxLength={MAX_TITLE}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Напр. Приветствие"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Текст ответа</Label>
        <AutoTextarea
          value={body}
          onChange={setBody}
          autoFocus
          maxLength={MAX_BODY}
          ariaLabel="Текст автоответа"
          placeholder="Здравствуйте! Чем могу помочь?"
          onSubmitShortcut={submit}
        />
        <span className="text-right text-[11px] text-muted-foreground tabular-nums">
          {body.length}/{MAX_BODY}
        </span>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={busy}
        >
          <X className="size-4" />
          Отмена
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={submit}
          disabled={busy || !body.trim()}
        >
          <Check className="size-4" />
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}

export function QuickRepliesManager({ initial }: { initial: QuickReply[] }) {
  const [replies, setReplies] = useState<QuickReply[]>(initial)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function create(title: string, body: string) {
    startTransition(async () => {
      const res = await createQuickReplyAction(title, body)
      if (!res.ok || !res.reply) {
        toast.error(res.message)
        return
      }
      setReplies((prev) => [...prev, res.reply as QuickReply])
      setCreating(false)
      toast.success(res.message)
    })
  }

  function update(id: string, title: string, body: string) {
    startTransition(async () => {
      const res = await updateQuickReplyAction(id, title, body)
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      setReplies((prev) =>
        prev.map((r) => (r.id === id ? { ...r, title, body } : r)),
      )
      setEditingId(null)
      toast.success(res.message)
    })
  }

  function remove(id: string) {
    // Optimistic removal; restore on failure.
    const prev = replies
    setReplies((list) => list.filter((r) => r.id !== id))
    startTransition(async () => {
      const res = await deleteQuickReplyAction(id)
      if (!res.ok) {
        setReplies(prev)
        toast.error(res.message)
        return
      }
      toast.success(res.message)
    })
  }

  function move(index: number, dir: -1 | 1) {
    const next = [...replies]
    const target = index + dir
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setReplies(next)
    const orderedIds = next.map((r) => r.id)
    startTransition(async () => {
      const res = await reorderQuickRepliesAction(orderedIds)
      if (!res.ok) toast.error(res.message)
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Create */}
      <Card className="p-4 sm:p-5">
        {creating ? (
          <ReplyEditor
            busy={pending}
            submitLabel="Создать"
            onSubmit={create}
            onCancel={() => setCreating(false)}
          />
        ) : (
          <Button
            type="button"
            variant="outline"
            className="w-full justify-center border-dashed"
            onClick={() => {
              setCreating(true)
              setEditingId(null)
            }}
          >
            <Plus className="size-4" />
            Добавить автоответ
          </Button>
        )}
      </Card>

      {/* List */}
      {replies.length === 0 && !creating ? (
        <Card className="p-8">
          <EmptyState
            icon={MessageSquareText}
            title="Пока нет автоответов"
            description="Создайте заготовки частых ответов — они появятся над полем ввода в диалоге, чтобы отвечать в один клик."
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {replies.map((r, i) => (
            <Card key={r.id} className="overflow-hidden p-4">
              {editingId === r.id ? (
                <ReplyEditor
                  initialTitle={r.title}
                  initialBody={r.body}
                  busy={pending}
                  submitLabel="Сохранить"
                  onSubmit={(title, body) => update(r.id, title, body)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <div className="flex items-start gap-3">
                  {/* Reorder controls */}
                  <div className="flex flex-col gap-1 pt-0.5">
                    <button
                      type="button"
                      onClick={() => move(i, -1)}
                      disabled={i === 0 || pending}
                      aria-label="Поднять выше"
                      className={cn(
                        'flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                        (i === 0 || pending) && 'pointer-events-none opacity-30',
                      )}
                    >
                      <ArrowUp className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(i, 1)}
                      disabled={i === replies.length - 1 || pending}
                      aria-label="Опустить ниже"
                      className={cn(
                        'flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                        (i === replies.length - 1 || pending) &&
                          'pointer-events-none opacity-30',
                      )}
                    >
                      <ArrowDown className="size-3.5" />
                    </button>
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    {r.title ? (
                      <p className="truncate text-sm font-semibold text-foreground">
                        {r.title}
                      </p>
                    ) : null}
                    <p
                      className={cn(
                        'whitespace-pre-wrap break-words text-sm text-muted-foreground',
                        r.title ? 'mt-0.5' : '',
                      )}
                    >
                      {r.body}
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => {
                        setEditingId(r.id)
                        setCreating(false)
                      }}
                      aria-label="Редактировать"
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => remove(r.id)}
                      aria-label="Удалить"
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
