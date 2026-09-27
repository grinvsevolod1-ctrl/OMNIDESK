'use client'

import { useEffect, useState, useTransition } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { Loader2, Mail } from 'lucide-react'
import {
  secretGetSitesContactEmailAction,
  secretSetSitesContactEmailAction,
} from '@/app/actions/admin-secret'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

/**
 * Global «email администратора» for every vitrine: shown in the modal the
 * page opens when the visitor clicks the balance in the sidebar.
 */
export function SitesContactCard() {
  const { data, mutate } = useSWR('god-sites-contact-email', () =>
    secretGetSitesContactEmailAction(),
  )
  const [value, setValue] = useState('')
  const [pending, start] = useTransition()

  useEffect(() => {
    if (data !== undefined) setValue(data)
  }, [data])

  const saved = data ?? ''
  const dirty = value.trim() !== saved

  function save() {
    start(async () => {
      const res = await secretSetSitesContactEmailAction(value)
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      await mutate(res.email ?? '', { revalidate: false })
    })
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Mail className="size-4" aria-hidden />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium">Email администратора</p>
          <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
            Общий для всех витрин. По клику на баланс витрина показывает окно
            «Для получения сведений о счёте обратитесь к администратору» с этим
            адресом. Пусто — окно без email.
          </p>
        </div>
      </div>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty && !pending) save()
        }}
      >
        <label htmlFor="sites-contact-email" className="sr-only">
          Email администратора
        </label>
        <Input
          id="sites-contact-email"
          type="email"
          inputMode="email"
          autoComplete="off"
          placeholder={data === undefined ? 'Загрузка…' : 'admin@example.com'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={data === undefined}
          className="h-9 text-sm sm:max-w-sm"
        />
        <Button type="submit" size="sm" className="h-9" disabled={!dirty || pending}>
          {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          Сохранить
        </Button>
      </form>
    </Card>
  )
}
