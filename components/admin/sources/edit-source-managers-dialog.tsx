'use client'

/**
 * Диалог состава менеджеров источника. Менеджер подключён максимум к одному
 * источнику: если он занят другим, показываем каким (выбор его «переводит»).
 * Атрибуция уже созданных лидов при переносе не меняется.
 */
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import { setSourceManagersAction } from '@/app/actions/admin-sources'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface AssignableManager {
  id: string
  name: string
  sourceId: string | null
  sourceName: string | null
}

export function EditSourceManagersDialog({
  sourceId,
  sourceName,
  currentManagerIds,
  allManagers,
  open,
  onOpenChange,
}: {
  sourceId: string
  sourceName: string
  currentManagerIds: string[]
  allManagers: AssignableManager[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(currentManagerIds),
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
      const res = await setSourceManagersAction(sourceId, [...selected])
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      onOpenChange(false)
      router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Менеджеры источника</DialogTitle>
          <DialogDescription>
            {`Отметьте менеджеров, чьи лиды атрибутируются источнику «${sourceName}». Менеджер может быть подключён только к одному источнику.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto py-1">
          {allManagers.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Менеджеров продаж пока нет.
            </p>
          )}
          {allManagers.map((m) => {
            const takenByOther =
              m.sourceId !== null && m.sourceId !== sourceId
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
                  {takenByOther ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {`сейчас на источнике: ${m.sourceName}`}
                    </span>
                  ) : null}
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
