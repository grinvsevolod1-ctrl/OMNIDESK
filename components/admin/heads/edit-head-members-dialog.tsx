'use client'

/**
 * Диалог изменения состава группы руководителя. Один компонент обслуживает
 * оба вида подчинённых:
 *   - kind='curator' — менеджеры по кадрам (setHeadCuratorsAction);
 *   - kind='manager' — менеджеры продаж (setHeadManagersAction).
 * Подчинённый принадлежит только одной группе: если он занят другим
 * руководителем, показываем, кем именно (выбор его «переводит»).
 */
import { useState, useTransition } from 'react'
import {
  setHeadCuratorsAction,
  setHeadManagersAction,
} from '@/app/actions/admin-heads'
import type {
  AssignableMember,
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

export function EditHeadMembersDialog({
  kind,
  group,
  allMembers,
  open,
  onOpenChange,
}: {
  kind: 'curator' | 'manager'
  group: HeadGroup
  /** Полный справочник подчинённых выбранного вида (с текущим руководителем). */
  allMembers: AssignableMember[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const current = kind === 'curator' ? group.curators : group.managers
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(current.map((m) => m.id)),
  )
  const [pending, startTransition] = useTransition()

  const noun = kind === 'curator' ? 'менеджеров по кадрам' : 'менеджеров продаж'
  const emptyText =
    kind === 'curator' ? 'Менеджеров по кадрам пока нет.' : 'Менеджеров продаж пока нет.'

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
      const res =
        kind === 'curator'
          ? await setHeadCuratorsAction(group.head.id, [...selected])
          : await setHeadManagersAction(group.head.id, [...selected])
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
            {`Отметьте ${noun}, лидов которых видит ${group.head.name}. Сотрудник может состоять только в одной группе.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto py-1">
          {allMembers.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {emptyText}
            </p>
          )}
          {allMembers.map((m) => {
            const takenByOther = m.headId !== null && m.headId !== group.head.id
            return (
              <label
                key={m.id}
                className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50"
              >
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={selected.has(m.id)}
                  onChange={() => toggle(m.id)}
                />
                <span
                  aria-hidden="true"
                  className="flex size-4 shrink-0 items-center justify-center rounded border border-input bg-background text-primary-foreground transition-colors peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring"
                >
                  {selected.has(m.id) ? <Check className="size-3" /> : null}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{m.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {m.city ?? 'Без города'}
                    {takenByOther && ` · сейчас у: ${m.headName}`}
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
