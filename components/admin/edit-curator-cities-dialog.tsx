'use client'

/**
 * Admin: edit the list of cities a curator covers. Comma-separated input with
 * dictionary suggestions; the first city becomes the primary one shown in the
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
import { CityInput } from '@/components/shared/city-input'
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
  const [value, setValue] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const { data: cities, mutate } = useSWR(
    open ? ['curator-cities', curator.id] : null,
    () => listCuratorCitiesAction(curator.id),
    { revalidateOnFocus: false },
  )

  const current =
    value ?? (cities && cities.length > 0 ? cities.join(', ') : (curator.city ?? ''))

  function save() {
    startTransition(async () => {
      const res = await updateCuratorCityAction(curator.id, current)
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
            Города куратора
          </DialogTitle>
          <DialogDescription>
            {curator.name}: города через запятую, первый — основной.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="curator-cities-input">Города</Label>
          <CityInput
            id="curator-cities-input"
            value={current}
            onValueChange={setValue}
            placeholder="Москва, Казань"
          />
          <p className="text-xs text-muted-foreground">
            Лиды подбираются по любому из указанных городов.
          </p>
        </div>
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="outline" type="button">
                Отмена
              </Button>
            }
          />
          <Button onClick={save} disabled={pending || !current.trim()}>
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
