'use client'

import { Loader2, MapPin } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CityInput } from '@/components/shared/city-input'
import { cn } from '@/lib/utils'
import { TelegramOutreachButton } from './telegram-outreach-button'
import type { LeadCardState } from './use-lead-card'

/** Поля карточки лида + подбор менеджера по кадрам по городу. */
export function LeadCardForm({ state }: { state: LeadCardState }) {
  const { fields, curators, searching, curatorId, setCuratorId } = state
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
        <Field label="Telegram">
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
            setCuratorId(null)
          }}
          placeholder="Москва"
        />
      </Field>
      <Field label="Адрес">
        <Input
          value={fields.address}
          onChange={(e) => fields.setAddress(e.target.value)}
          placeholder="Улица, дом"
        />
      </Field>
      <Field label="Вакансия / должность">
        <Input
          value={fields.vacancy}
          onChange={(e) => fields.setVacancy(e.target.value)}
          placeholder="Курьер, менеджер…"
        />
      </Field>

      {fields.city.trim().length >= 2 ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Менеджеры по кадрам по городу
          </span>
          {searching ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Ищем…
            </p>
          ) : curators.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
              Нет менеджеров по кадрам для «{fields.city.trim()}». Если это
              небольшой населённый пункт, укажите его область или регион
              (например, «Московская область») — подтянется менеджер по
              кадрам, который её покрывает.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {curators.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCuratorId(c.id)}
                  className={cn(
                    // min-w-0 по всей цепочке обязателен: без него длинный
                    // список городов растягивал кнопку шире панели и появлялся
                    // горизонтальный скролл всей карточки лида.
                    'flex w-full min-w-0 items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors',
                    curatorId === c.id
                      ? 'border-primary bg-primary/10 ring-1 ring-primary/30'
                      : 'border-border hover:bg-muted',
                  )}
                >
                  <span className="shrink-0 font-medium">{c.name}</span>
                  <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    <span className="flex min-w-0 items-center gap-1">
                      <MapPin className="size-3 shrink-0" />
                      <span className="truncate">
                        {c.cities?.length ? c.cities.join(', ') : c.city}
                      </span>
                    </span>
                    <span
                      className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px]"
                      title="Активных лидов у менеджера по кадрам"
                    >
                      {c.activeLeads} лид.
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
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
