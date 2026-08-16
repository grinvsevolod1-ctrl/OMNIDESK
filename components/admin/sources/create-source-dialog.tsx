'use client'

/**
 * ЕДИНЫЙ диалог создания «Источника» — используется и на вкладке «Обзор»,
 * и в «Учёте» (finance-admin). Источник — одна сущность (finance_resource
 * + привязанные каналы), поэтому и форма создания одна: название, описание
 * и необязательная привязка каналов сразу при создании.
 */

import { useState, useTransition } from 'react'
import { Check, Loader2 } from 'lucide-react'
import useSWR from 'swr'
import { toast } from 'sonner'
import {
  createSourceAction,
  listSourcesForSelectAction,
} from '@/app/actions/sources'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

export function CreateSourceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Вызывается после успешного создания (например, mutate SWR-ключей). */
  onCreated?: (id: string) => void
}) {
  const [pending, startTransition] = useTransition()
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Каналы и занятость подгружаются только при открытом диалоге; SWR
  // дедуплицирует ключ с другими потребителями (селект в настройках канала).
  const { data: selectRes } = useSWR(
    open ? 'sources-select' : null,
    () => listSourcesForSelectAction(),
    { revalidateOnFocus: false },
  )
  const channels = selectRes?.data?.channels ?? []
  const nameBySource = new Map(
    (selectRes?.data?.sources ?? []).map((s) => [s.id, s.name]),
  )

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const name = String(fd.get('name') ?? '').trim()
    const description = String(fd.get('description') ?? '').trim()
    if (!name) return
    startTransition(async () => {
      const res = await createSourceAction(name, [...selected], description)
      if (res.ok) {
        toast.success(res.message)
        setSelected(new Set())
        onOpenChange(false)
        if (res.id) onCreated?.(res.id)
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Новый источник</DialogTitle>
            <DialogDescription>
              Источник — единая сущность панели: статистика на «Обзоре» и
              финансы в «Учёте». Каналы можно привязать сейчас или позже.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="src-name">Название</Label>
              <Input
                id="src-name"
                name="name"
                placeholder="Например, site.com или «Лендинг Весна»"
                autoFocus
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="src-desc">Описание</Label>
              <Textarea
                id="src-desc"
                name="description"
                placeholder="Необязательно: что за источник, откуда идут лиды"
                rows={2}
              />
            </div>
            {channels.length > 0 ? (
              <div className="space-y-2">
                <Label>Каналы</Label>
                <div className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2">
                  {channels.map((ch) => {
                    const owner = ch.sourceId
                      ? nameBySource.get(ch.sourceId)
                      : null
                    const isOn = selected.has(ch.id)
                    return (
                      <button
                        key={ch.id}
                        type="button"
                        onClick={() => toggle(ch.id)}
                        aria-pressed={isOn}
                        className={cn(
                          'flex items-center gap-2 rounded-sm px-1.5 py-1 text-left text-sm hover:bg-muted/50',
                          isOn && 'bg-primary/10',
                        )}
                      >
                        <span
                          className={cn(
                            'flex size-4 shrink-0 items-center justify-center rounded-sm border',
                            isOn
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border',
                          )}
                        >
                          {isOn ? <Check className="size-3" /> : null}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {ch.name}
                        </span>
                        {owner ? (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            сейчас: {owner}
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  Канал принадлежит одному источнику: выбор занятого канала
                  перенесёт его сюда.
                </p>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline">
                  Отмена
                </Button>
              }
            />
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Создать
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
