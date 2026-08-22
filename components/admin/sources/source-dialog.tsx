'use client'

/**
 * Диалог создания/редактирования источника трафика: название, байер,
 * дневное окно статистики (всё вне окна — «долёты»), заметки, активность.
 */
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import {
  createSourceAction,
  updateSourceAction,
} from '@/app/actions/admin-sources'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

export interface BuyerOption {
  id: string
  name: string
  status: 'active' | 'blocked'
}

export interface SourceFormValue {
  id: string
  name: string
  buyerId: string | null
  dayStart: number
  dayEnd: number
  notes: string | null
  isActive: boolean
}

function hhmm(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0')
  const m = String(minutes % 60).padStart(2, '0')
  return `${h}:${m}`
}

const NO_BUYER = 'none'

export function SourceDialog({
  buyers,
  source,
  open: controlledOpen,
  onOpenChange,
}: {
  buyers: BuyerOption[]
  /** Без source — режим создания (рендерит свой триггер). */
  source?: SourceFormValue
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const router = useRouter()
  const editing = !!source
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = onOpenChange ?? setUncontrolledOpen
  const [pending, startTransition] = useTransition()
  const [buyerId, setBuyerId] = useState<string>(source?.buyerId ?? NO_BUYER)
  const [isActive, setIsActive] = useState(source?.isActive ?? true)

  function handleSubmit(formData: FormData) {
    formData.set('buyerId', buyerId === NO_BUYER ? '' : buyerId)
    if (editing) {
      formData.set('id', source.id)
      formData.set('isActive', isActive ? 'true' : 'false')
    }
    startTransition(async () => {
      const res = editing
        ? await updateSourceAction(formData)
        : await createSourceAction(formData)
      if (res.ok) {
        toast.success(res.message)
        setOpen(false)
        router.refresh()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!editing ? (
        <DialogTrigger
          render={
            <Button variant="outline">
              <Plus className="size-4" />
              Новый источник
            </Button>
          }
        />
      ) : null}
      <DialogContent className="sm:max-w-md">
        <form action={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Настройки источника' : 'Создать источник'}
            </DialogTitle>
            <DialogDescription>
              Менеджеры, подключённые к источнику, наследуют его окно
              статистики. Лиды вне дневного окна считаются «долётами».
            </DialogDescription>
          </DialogHeader>
          <div className="my-4 flex max-h-[min(60dvh,34rem)] flex-col gap-4 overflow-y-auto overscroll-contain pr-1">
            <div className="flex flex-col gap-2">
              <Label htmlFor="source-name">Название</Label>
              <Input
                id="source-name"
                name="name"
                placeholder="Например: Facebook · РК-1"
                defaultValue={source?.name ?? ''}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>Медиабайер</Label>
              <Select
                value={buyerId}
                onValueChange={(v) => setBuyerId(v ?? NO_BUYER)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Без байера" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_BUYER}>Без байера</SelectItem>
                  {buyers.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                      {b.status === 'blocked' ? ' · заблокирован' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="source-day-start">День с</Label>
                <Input
                  id="source-day-start"
                  name="dayStart"
                  type="time"
                  defaultValue={hhmm(source?.dayStart ?? 540)}
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="source-day-end">День до</Label>
                <Input
                  id="source-day-end"
                  name="dayEnd"
                  type="time"
                  defaultValue={hhmm(source?.dayEnd ?? 1080)}
                  required
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              «Долёты» — всё остальное время суток (по умолчанию 18:00–09:00).
            </p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="source-notes">
                Заметки{' '}
                <span className="font-normal text-muted-foreground">
                  (необязательно)
                </span>
              </Label>
              <Textarea
                id="source-notes"
                name="notes"
                rows={2}
                placeholder="Кабинет, гео, крео…"
                defaultValue={source?.notes ?? ''}
              />
            </div>
            {editing ? (
              <div className="flex items-center justify-between rounded-lg border border-border p-3">
                <div className="flex flex-col gap-0.5 pr-3">
                  <Label htmlFor="source-active">Источник активен</Label>
                  <p className="text-xs text-muted-foreground">
                    Выключенный источник остаётся в статистике, но помечается
                    как неактивный.
                  </p>
                </div>
                <Switch
                  id="source-active"
                  checked={isActive}
                  onCheckedChange={setIsActive}
                />
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose
              render={
                <Button variant="outline" type="button">
                  Отмена
                </Button>
              }
            />
            <Button type="submit" disabled={pending}>
              {pending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Сохраняем…
                </>
              ) : editing ? (
                'Сохранить'
              ) : (
                'Создать источник'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
