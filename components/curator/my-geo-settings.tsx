'use client'

/**
 * «Мои ГЕО»: менеджер по кадрам сам управляет списком своих городов —
 * добавляет и удаляет, включая населённые пункты, которых нет в справочнике
 * (например, «Внуково»). Первый город — основной. Тот же CityListInput, что
 * в админских диалогах; список скроллится внутри карточки.
 */
import { useState, useTransition } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import useSWR from 'swr'
import {
  listMyCitiesAction,
  updateMyCitiesAction,
} from '@/app/actions/managers'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { CityListInput } from '@/components/shared/city-list-input'

export function MyGeoSettings() {
  const [value, setValue] = useState<string[] | null>(null)
  const [pending, startTransition] = useTransition()

  const { data: saved, mutate } = useSWR('my-geo-cities', listMyCitiesAction, {
    revalidateOnFocus: false,
  })

  // Пока куратор не начал редактировать — показываем сохранённый список.
  const current = value ?? (saved && saved.length > 0 ? saved : [''])
  const joined = current
    .map((c) => c.trim())
    .filter(Boolean)
    .join(', ')
  const dirty = value !== null

  function save() {
    startTransition(async () => {
      const res = await updateMyCitiesAction(joined)
      if (res.ok) {
        toast.success(res.message)
        await mutate()
        setValue(null)
      } else {
        toast.error(res.message)
      }
    })
  }

  // Новое поле вставляем СВЕРХУ списка — кнопка живёт в шапке, и добавленный
  // инпут появляется сразу под ней без прокрутки длинного списка. Первый
  // (верхний) город остаётся основным, что видно куратору сразу.
  function addCity() {
    setValue(['', ...current])
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="my-geo-input">Мои города и регионы</Label>
        <Button type="button" variant="outline" size="sm" onClick={addCity}>
          <Plus className="size-4" />
          Добавить город
        </Button>
      </div>
      <div className="flex max-h-[26rem] flex-col gap-2 overflow-y-auto overscroll-contain pr-1">
        <CityListInput
          idPrefix="my-geo-input"
          cities={current}
          onChange={setValue}
          hideAddButton
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Можно указывать и населённые пункты, которых нет в подсказках, — они
        будут добавлены в справочник. Чтобы покрыть сразу всю область, укажите
        её название (например, «Московская область»).
      </p>
      <div className="flex items-center gap-3">
        <Button
          onClick={save}
          disabled={pending || !dirty || joined.length === 0}
        >
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Сохраняем…
            </>
          ) : (
            'Сохранить'
          )}
        </Button>
        {dirty ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => setValue(null)}
          >
            Отменить изменения
          </Button>
        ) : null}
      </div>
    </div>
  )
}
