'use client'

/**
 * Диалог изменения состава группы руководителя: чекбоксы по всем менеджерам
 * по кадрам. Куратор может состоять только в одной группе — если он занят
 * другим руководителем, показываем, кем именно (выбор его «переводит»).
 */
import { useState, useTransition } from 'react'
import { setHeadCuratorsAction } from '@/app/actions/admin-heads'
import type {
  AssignableCurator,
  HeadGroup,
} from '@/components/admin/heads/heads-table'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'

export function EditHeadCuratorsDialog({
  group,
  allCurators,
  open,
  onOpenChange,
}: {
  group: HeadGroup
  allCurators: AssignableCurator[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(group.curators.map((c) => c.id)),
  )
  const [pending, startTransition] = useTransition()

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function save() {
    startTransition(async () => {
      const res = await setHeadCuratorsAction(group.head.id, [...selected])
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      onOpenChange(false)
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Группа руководителя</DialogTitle>
          <DialogDescription>
            {`Отметьте менеджеров по кадрам, лидов которых видит ${group.head.name}. Куратор может состоять только в одной группе.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto py-1">
          {allCurators.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Менеджеров по кадрам пока нет.
            </p>
          )}
          {allCurators.map((c) => {
            const takenByOther =
              c.headId !== null && c.headId !== group.head.id
            return (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50"
              >
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={selected.has(c.id)}
                  onChange={() => toggle(c.id)}
                />
                <span
                  aria-hidden="true"
                  className="flex size-4 shrink-0 items-center justify-center rounded border border-input bg-background text-primary-foreground transition-colors peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring"
                >
                  {selected.has(c.id) ? <Check className="size-3" /> : null}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{c.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {c.city ?? 'Без города'}
                    {takenByOther && ` · сейчас у: ${c.headName}`}
                  </span>
                </span>
              </label>
            )
          })}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Отмена
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
