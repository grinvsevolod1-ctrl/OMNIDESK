'use client'

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Field, type TabProps } from './shared'

export function ContentTab({ config, patch }: TabProps) {
  const c = config.content
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Приветственное сообщение"
        hint="Бабл от агента при открытии чата, чтобы он не был пустым."
      >
        <Textarea
          value={c.welcomeMessage}
          onChange={(e) =>
            patch((d) => void (d.content.welcomeMessage = e.target.value))
          }
          placeholder="Здравствуйте! Чем можем помочь?"
          rows={3}
        />
      </Field>

      <Field
        label="Быстрые ответы"
        hint="Чипы-подсказки под приветствием. По клику подставляются в поле."
      >
        <QuickReplyEditor
          items={c.quickReplies}
          onChange={(items) =>
            patch((d) => void (d.content.quickReplies = items))
          }
        />
      </Field>

      <Field label="Плейсхолдер поля ввода">
        <Input
          value={c.inputPlaceholder}
          onChange={(e) =>
            patch((d) => void (d.content.inputPlaceholder = e.target.value))
          }
          placeholder="Введите сообщение..."
        />
      </Field>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-medium">Мессенджеры в рабочее время</p>
          <p className="text-xs text-muted-foreground">
            Показывать кнопки мессенджеров прямо в чате, а не только офлайн.
          </p>
        </div>
        <Switch
          checked={c.showMessengers}
          onCheckedChange={(v) =>
            patch((d) => void (d.content.showMessengers = Boolean(v)))
          }
        />
      </div>

      {c.showMessengers ? (
        <Field label="Заголовок над кнопками мессенджеров">
          <Input
            value={c.messengersTitle}
            onChange={(e) =>
              patch((d) => void (d.content.messengersTitle = e.target.value))
            }
            placeholder="Или напишите в мессенджер"
          />
        </Field>
      ) : null}
    </div>
  )
}

function QuickReplyEditor({
  items,
  onChange,
}: {
  items: string[]
  onChange: (items: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  function add() {
    const v = draft.trim()
    if (!v || items.length >= 6) return
    onChange([...items, v])
    setDraft('')
  }
  return (
    <div className="flex flex-col gap-2">
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it, i) => (
            <span
              key={`${it}-${i}`}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 py-1 pl-2.5 pr-1 text-xs"
            >
              {it}
              <button
                type="button"
                onClick={() => onChange(items.filter((_, idx) => idx !== i))}
                className="flex size-4 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={`Удалить «${it}»`}
              >
                <Trash2 className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {items.length < 6 ? (
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            placeholder="Например: Узнать цены"
          />
          <Button type="button" variant="outline" size="icon" onClick={add}>
            <Plus className="size-4" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
