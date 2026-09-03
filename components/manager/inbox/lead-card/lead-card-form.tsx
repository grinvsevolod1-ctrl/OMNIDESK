'use client'

import { useState } from 'react'
import { Landmark, Plus, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CityInput } from '@/components/shared/city-input'
import { TelegramOutreachButton } from './telegram-outreach-button'
import type { LeadCardState } from './use-lead-card'

/**
 * Поля карточки лида. Конкретного менеджера по кадрам менеджер больше НЕ
 * выбирает (миграция 150): при передаче лид уходит в пул команды и
 * разбирается кураторами. Город остаётся — по нему идёт маршрутизация в пул
 * по региону (подсказка области помогает менеджеру ввести корректный город).
 */
export function LeadCardForm({ state }: { state: LeadCardState }) {
  const { fields, cityRegion } = state
  // «+ добавить адрес»: клик раскрывает строку ввода; уже заполненный адрес
  // (например, из сохранённой карточки) показывает поле автоматически.
  const [addressAdded, setAddressAdded] = useState(false)
  const showAddress = addressAdded || fields.address.trim() !== ''
  return (
    <>
      <Field label="ФИО" required>
        <Input
          value={fields.fullName}
          onChange={(e) => fields.setFullName(e.target.value)}
          placeholder="Иван Иванов"
          autoComplete="name"
        />
      </Field>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field label="Телефон">
          <Input
            value={fields.phone}
            onChange={(e) => fields.setPhone(e.target.value)}
            placeholder="+7…"
            inputMode="tel"
          />
        </Field>
        <Field label="Telegram" required>
          <div className="flex items-center gap-1.5">
            <Input
              value={fields.telegramUsername}
              onChange={(e) => fields.setTelegramUsername(e.target.value)}
              placeholder="@username"
              className="min-w-0 flex-1"
            />
            <TelegramOutreachButton
              username={fields.telegramUsername}
              telegramId={fields.telegramId}
              contactName={fields.fullName.trim() || undefined}
            />
          </div>
        </Field>
      </div>
      <Field label="Telegram ID">
        <Input
          value={fields.telegramId}
          onChange={(e) => fields.setTelegramId(e.target.value)}
          placeholder="123456789"
          inputMode="numeric"
        />
      </Field>
      <Field label="Город" required>
        <CityInput
          value={fields.city}
          onValueChange={(v) => {
            fields.setCity(v)
            pickCurator(null)
          }}
          placeholder="Москва"
        />
        {cityRegion?.region ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Landmark className="size-3 shrink-0" />
            {cityRegion.isRegion ? (
              <span>{cityRegion.region} — весь регион</span>
            ) : (
              <span>Область: {cityRegion.region}</span>
            )}
          </p>
        ) : null}
      </Field>
      {/* Адрес скрыт по умолчанию: в большинстве лидов он не нужен. Строка
          ввода появляется по клику «+ добавить адрес»; если адрес уже
          сохранён в карточке — поле показано сразу. */}
      {showAddress ? (
        <Field label="Адрес">
          <div className="flex items-center gap-1.5">
            <Input
              value={fields.address}
              onChange={(e) => fields.setAddress(e.target.value)}
              placeholder="Улица, дом"
              className="min-w-0 flex-1"
              autoFocus={!fields.address}
            />
            <button
              type="button"
              className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Убрать адрес"
              title="Убрать адрес"
              onClick={() => {
                fields.setAddress('')
                setAddressAdded(false)
              }}
            >
              <X className="size-3.5" />
            </button>
          </div>
        </Field>
      ) : (
        <button
          type="button"
          onClick={() => setAddressAdded(true)}
          className="flex w-fit items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
        >
          <Plus className="size-3.5" />
          добавить адрес
        </button>
      )}
      <Field label="Вакансия / должность" required>
        <Input
          value={fields.vacancy}
          onChange={(e) => fields.setVacancy(e.target.value)}
          placeholder="Курьер, менеджер…"
        />
      </Field>

      <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
        При передаче лид уйдёт в вашу команду и появится у кураторов
        по городу — кто&nbsp;первый возьмёт его в работу, за тем он и
        закрепится.
      </p>
    </>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {children}
    </div>
  )
}
