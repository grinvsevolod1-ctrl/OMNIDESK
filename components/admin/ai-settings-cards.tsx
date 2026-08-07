'use client'

/**
 * Read-only directives card and the knowledge-base editor card, split out of
 * ai-settings-tab.tsx. Both self-fetch through server actions on mount.
 */

import { useCallback, useEffect, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { BookOpen, Loader2, Plus, ScrollText, Trash2 } from 'lucide-react'
import {
  aiDeleteKnowledgeAction,
  aiListDirectivesAction,
  aiListKnowledgeAction,
  aiSaveKnowledgeAction,
} from '@/app/actions/ai-assist'
import { type KnowledgeEntry } from '@/lib/data/ai-assist'
import { type AiDirective } from '@/lib/data/ai-directives'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

export function DirectivesCard() {
  const [items, setItems] = useState<AiDirective[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, startLoad] = useTransition()

  useEffect(() => {
    startLoad(async () => {
      try {
        setItems(await aiListDirectivesAction())
      } catch {
        /* silent — table may be pre-migration */
      } finally {
        setLoaded(true)
      }
    })
  }, [])

  const activeCount = items.filter((d) => d.enabled).length

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary">
          <ScrollText className="size-5" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <p className="font-medium">Правила от руководителя</p>
            {loaded && items.length > 0 ? (
              <Badge variant="secondary" className="shrink-0">
                {activeCount} из {items.length} активны
              </Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            Указания, которым ИИ следует в первую очередь. Задаются и меняются
            через чат с ассистентом — здесь их можно только просмотреть.
          </p>
        </div>
      </div>

      {loading && !loaded ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          Загрузка…
        </p>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-4 text-center text-sm text-muted-foreground">
          Пока нет правил. Скажите ассистенту в чате, например: «Всегда уточняй
          город клиента» — и правило появится здесь.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {items.map((d, i) => (
            <li
              key={d.id}
              className={cn(
                'flex items-start gap-3 rounded-lg border border-border p-3',
                !d.enabled && 'opacity-60',
              )}
            >
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                {i + 1}
              </span>
              <p className="flex-1 whitespace-pre-wrap text-sm leading-relaxed">
                {d.body}
              </p>
              {!d.enabled ? (
                <Badge variant="outline" className="shrink-0">
                  Выключено
                </Badge>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

/* --------------------------- RAG knowledge base ------------------------- */

/**
 * Manage the manager-brain knowledge base (prices, terms, FAQ). Entries are
 * embedded server-side and retrieved by semantic similarity at reply time, so
 * the AI quotes real facts instead of hallucinating.
 */
export function KnowledgeBaseCard() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([])
  const [loading, startLoad] = useTransition()
  const [saving, startSave] = useTransition()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')

  const load = useCallback(() => {
    startLoad(async () => {
      try {
        setEntries(await aiListKnowledgeAction())
      } catch {
        /* silent */
      }
    })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const add = () => {
    if (!content.trim()) {
      toast.error('Введите текст факта.')
      return
    }
    startSave(async () => {
      try {
        await aiSaveKnowledgeAction({ title, content })
        setTitle('')
        setContent('')
        toast.success('Добавлено в базу знаний')
        load()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не удалось сохранить')
      }
    })
  }

  const remove = (id: string) => {
    startSave(async () => {
      try {
        await aiDeleteKnowledgeAction(id)
        toast.success('Удалено')
        load()
      } catch {
        toast.error('Не удалось удалить')
      }
    })
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary">
          <BookOpen className="size-5" />
        </div>
        <div>
          <p className="font-medium">База знаний</p>
          <p className="text-sm text-muted-foreground">
            Точные факты — цены, условия, ответы на частые вопросы. ИИ подбирает
            подходящие записи по смыслу и использует их в ответах, не выдумывая
            цифры.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <Input
          placeholder="Заголовок (необязательно), напр. «Стоимость доставки»"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Textarea
          placeholder="Факт, который ИИ должен знать точно. Напр.: «Доставка по РФ — 350 ₽, бесплатно от 5000 ₽, срок 2–5 дней»."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={3}
        />
        <div className="flex justify-end">
          <Button onClick={add} disabled={saving}>
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Добавить факт
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          Загрузка…
        </p>
      ) : entries.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          База знаний пуста. Добавьте факты, чтобы ИИ отвечал точнее.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((e) => (
            <li
              key={e.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"
            >
              <div className="min-w-0">
                {e.title ? <p className="font-medium">{e.title}</p> : null}
                <p className="text-sm text-muted-foreground">{e.content}</p>
                {!e.hasEmbedding ? (
                  <p className="mt-1 text-xs text-destructive">
                    Не проиндексировано — пока не участвует в поиске.
                  </p>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => remove(e.id)}
                disabled={saving}
                aria-label="Удалить факт"
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
