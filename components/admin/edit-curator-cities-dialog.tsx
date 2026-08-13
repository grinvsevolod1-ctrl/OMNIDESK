'use client'

/**
 * Admin: edit the list of cities a curator covers. One field per city with
 * dictionary suggestions; the first city is the primary one shown in the
 * curators table.
 */
import { useState, useTransition } from 'react'
import { Loader2, MapPin } from 'lucide-react'
import { toast } from 'sonner'
import useSWR from 'swr'
import {
  listCuratorCitiesAction,
  updateCuratorCityAction,
} from '@/app/actions/managers'
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
import { Label } from '@/components/ui/label'
import { CityListInput } from '@/components/shared/city-list-input'
import type { Manager } from '@/lib/types'

export function EditCuratorCitiesDialog({
  curator,
  open,
  onOpenChange,
}: {
  curator: Manager
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const [value, setValue] = useState<string[] | null>(null)
  const [pending, startTransition] = useTransition()

  const { data: cities, mutate } = useSWR(
    open ? ['curator-cities', curator.id] : null,
    () => listCuratorCitiesAction(curator.id),
    { revalidateOnFocus: false },
  )

  // Until the admin edits, show the saved list (with legacy city fallback).
  const current =
    value ??
    (cities && cities.length > 0
      ? cities
      : curator.city
        ? [curator.city]
        : [''])
  const joined = current
    .map((c) => c.trim())
    .filter(Boolean)
    .join(', ')

  function save() {
    startTransition(async () => {
      const res = await updateCuratorCityAction(curator.id, joined)
      if (res.ok) {
        toast.success(res.message)
        await mutate()
        setValue(null)
        onOpenChange(false)
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) setValue(null)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="size-4" />
            Города менеджера по кадрам
          </DialogTitle>
          <DialogDescription>
            {curator.name}: добавьте по одному городу на поле.
          </DialogDescription>
        </DialogHeader>
        {/* Список городов скроллится внутри диалога: при десятках позиций
            шапка и кнопка «Сохранить» остаются на экране. */}
        <div className="flex max-h-[min(55dvh,30rem)] flex-col gap-2 overflow-y-auto overscroll-contain pr-1">
          <Label htmlFor="curator-cities-input">Города</Label>
          <CityListInput
            idPrefix="curator-cities-input"
            cities={current}
            onChange={setValue}
          />
        </div>
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="outline" type="button">
                Отмена
              </Button>
            }
          />
          <Button onClick={save} disabled={pending || joined.length === 0}>
            {pending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Сохраняем…
              </>
            ) : (
              'Сохранить'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
