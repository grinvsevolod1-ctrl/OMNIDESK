'use client'

/**
 * «Мои ГЕО»: менеджер по кадрам сам управляет списком своих городов —
 * добавляет и удаляет, включая населённые пункты, которых нет в справочнике
 * (например, «Внуково»). Первый город — основной. Тот же CityListInput, что
 * в админских диалогах; список скроллится внутри карточки.
 */
import { useState, useTransition } from 'react'
import { Loader2, Plus, Send } from 'lucide-react'
import { toast } from 'sonner'
import useSWR from 'swr'
import {
  getMyTelegramContactAction,
  listMyCitiesAction,
  updateMyCitiesAction,
  updateMyTelegramContactAction,
} from '@/app/actions/managers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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

      <MyTelegramContact />
    </div>
  )
}

/**
 * «Telegram для кандидатов» (миграция 146): куратор сам указывает и в любой
 * момент обновляет свой актуальный Telegram — например, если аккаунт слетел
 * или заменён. Принимаются «@username» и ссылки t.me/username; система
 * приводит к единому виду «@username». Этот контакт менеджер видит при
 * передаче лида и отправляет кандидату — кандидат пишет куратору сам.
 */
function MyTelegramContact() {
  const [draft, setDraft] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const { data: saved, mutate } = useSWR(
    'my-telegram-contact',
    getMyTelegramContactAction,
    { revalidateOnFocus: false },
  )

  const current = draft ?? saved ?? ''
  const dirty = draft !== null && draft !== (saved ?? '')

  function save() {
    startTransition(async () => {
      const res = await updateMyTelegramContactAction(current)
      if (res.ok) {
        toast.success(res.message)
        await mutate()
        setDraft(null)
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <Label htmlFor="my-telegram-contact" className="flex items-center gap-1.5">
        <Send className="size-3.5" />
        Telegram для кандидатов
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id="my-telegram-contact"
          value={current}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="@username или t.me/username"
          className="max-w-xs"
          autoComplete="off"
        />
        <Button onClick={save} disabled={pending || !dirty}>
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Сохраняем…
            </>
          ) : (
            'Сохранить'
          )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Этот контакт видит менеджер при передаче вам лида и отправляет его
        кандидату — кандидат напишет вам сам. Если Telegram-аккаунт слетел или
        заменён, просто укажите новый: он сразу будет использоваться при всех
        следующих передачах.
      </p>
    </div>
  )
}
