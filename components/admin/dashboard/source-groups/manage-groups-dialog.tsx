'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Layers, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  deleteSourceGroupAction,
  updateSourceGroupAction,
} from '@/app/actions/groups'
import { useChannelTypeLabels } from '@/components/dictionaries-provider'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { SourceGroup } from '@/lib/data'
import { cn } from '@/lib/utils'
import { typeDot, type ChannelOption } from './shared'

/** Create / edit / delete source groups and their channel membership. */
export function ManageGroupsDialog({
  groups,
  channels,
  triggerLabel = 'Управление источниками',
}: {
  groups: SourceGroup[]
  channels: ChannelOption[]
  triggerLabel?: string
}) {
  const TYPE_LABEL = useChannelTypeLabels()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, startTransition] = useTransition()

  // Which group currently owns each channel (to show a hint on the toggle).
  const ownerByChannel = useMemo(() => {
    const m = new Map<string, string>()
    for (const g of groups) for (const c of g.channels) m.set(c.id, g.name)
    return m
  }, [groups])

  function resetForm() {
    setEditingId(null)
    setName('')
    setSelected(new Set())
  }

  function startEdit(g: SourceGroup) {
    setEditingId(g.id)
    setName(g.name)
    setSelected(new Set(g.channels.map((c) => c.id)))
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function submit() {
    // Создание источника живёт в ЕДИНОМ диалоге CreateSourceDialog
    // (кнопка «Новый источник» на Обзоре и в Учёте). Здесь — только правка.
    if (!editingId) return
    const ids = [...selected]
    startTransition(async () => {
      const res = await updateSourceGroupAction(editingId, name, ids)
      if (res.ok) {
        toast.success(res.message)
        resetForm()
        router.refresh()
      } else {
        toast.error(res.message)
      }
    })
  }

  function remove(id: string) {
    // Источник теперь единая сущность: удаление снесёт и его финансы (кабинеты,
    // расходы, хранилище) в «Учёте», а не только привязку каналов. Предупреждаем.
    const ok = window.confirm(
      'Удалить источник целиком?\n\nВместе с ним из «Учёта» удалятся все рекламные кабинеты, расходы и данные хранилища этого источника. Это действие необратимо.',
    )
    if (!ok) return
    startTransition(async () => {
      const res = await deleteSourceGroupAction(id)
      if (res.ok) {
        toast.success(res.message)
        if (editingId === id) resetForm()
        router.refresh()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) resetForm()
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" className="gap-1.5">
            <Layers className="size-4" />
            {triggerLabel}
          </Button>
        }
      />
      <DialogContent className="flex max-h-[90vh] w-[min(720px,96vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(720px,96vw)]">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>Источники</DialogTitle>
          <DialogDescription>
            Источник объединяет каналы одного сайта или кампании. Это единая
            сущность для всей панели: статистика в «Обзоре» и финансы в «Учёте».
            Входящие сообщения группировка не затрагивает.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {/* Existing groups */}
          {groups.length > 0 ? (
            <ul className="mb-5 flex flex-col gap-2">
              {groups.map((g) => (
                <li
                  key={g.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{g.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {g.channels.length > 0
                        ? g.channels
                            .map((c) => `${TYPE_LABEL[c.type]}: ${c.name}`)
                            .join(' · ')
                        : 'Нет каналов'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => startEdit(g)}
                    >
                      Изменить
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => remove(g.id)}
                      disabled={pending}
                      aria-label="Удалить источник"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-5 text-sm text-muted-foreground">
              Источников пока нет. Создайте первый кнопкой «Новый источник».
            </p>
          )}

          {/* Edit form: создание — в едином диалоге CreateSourceDialog */}
          {editingId ? (
          <div className="rounded-lg border border-border p-4">
            <p className="mb-3 text-sm font-medium">Редактирование источника</p>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="group-name" className="text-xs">
                  Название
                </Label>
                <Input
                  id="group-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Например: Сайт acme.com"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">Каналы источника</Label>
                {channels.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Сначала подключите каналы (Telegram, WhatsApp, онлайн-чат).
                  </p>
                ) : (
                  <div className="flex max-h-[260px] flex-col gap-1.5 overflow-y-auto">
                    {channels.map((c) => {
                      const on = selected.has(c.id)
                      const owner = ownerByChannel.get(c.id)
                      const takenByOther =
                        owner &&
                        (!editingId || !selected.has(c.id)) &&
                        owner !== groups.find((g) => g.id === editingId)?.name
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => toggle(c.id)}
                          className={cn(
                            'flex items-center justify-between gap-3 rounded-md border p-2.5 text-left transition-colors',
                            on
                              ? 'border-primary bg-primary/5'
                              : 'border-border hover:bg-muted/50',
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            <span
                              className={cn(
                                'size-2.5 shrink-0 rounded-full',
                                typeDot(c.type),
                              )}
                              aria-hidden
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium">
                                {c.name}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {TYPE_LABEL[c.type]}
                                {c.detail ? ` · ${c.detail}` : ''}
                                {takenByOther ? ` · сейчас в «${owner}»` : ''}
                              </span>
                            </span>
                          </span>
                          <span
                            className={cn(
                              'flex size-5 shrink-0 items-center justify-center rounded-full border',
                              on
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border',
                            )}
                          >
                            {on ? <Check className="size-3.5" /> : null}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button variant="outline" onClick={resetForm} disabled={pending}>
                  Отмена
                </Button>
                <Button onClick={submit} disabled={pending || !name.trim()}>
                  {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Сохранить
                </Button>
              </div>
            </div>
          </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
