'use client'

import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { WidgetMessenger, WidgetMessengerType } from '@/lib/widget-config'
import type { TabProps } from './shared'

export function MessengersTab({ config, patch }: TabProps) {
  function update(i: number, next: Partial<WidgetMessenger>) {
    patch((d) => {
      d.messengers[i] = { ...d.messengers[i], ...next }
    })
  }
  function add() {
    patch((d) => {
      if (d.messengers.length >= 8) return
      d.messengers.push({ type: 'telegram', label: 'Telegram', value: '' })
    })
  }
  function remove(i: number) {
    patch((d) => {
      d.messengers.splice(i, 1)
    })
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Кнопки мессенджеров показываются в нерабочее время и, если включено, в
        рабочее. Для WhatsApp укажите номер телефона, для Telegram/произвольной —
        полную ссылку.
      </p>
      {config.messengers.map((m, i) => (
        <div
          key={i}
          className="flex flex-col gap-2 rounded-lg border border-border p-3"
        >
          <div className="flex items-center gap-2">
            <Select
              value={m.type}
              onValueChange={(v) =>
                update(i, { type: v as WidgetMessengerType })
              }
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="telegram">Telegram</SelectItem>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
                <SelectItem value="custom">Другое</SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={m.label}
              onChange={(e) => update(i, { label: e.target.value })}
              placeholder="Подпись кнопки"
              className="flex-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => remove(i)}
              aria-label="Удалить мессенджер"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
          <Input
            value={m.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder={
              m.type === 'whatsapp'
                ? '+7 999 123-45-67'
                : m.type === 'telegram'
                  ? 'https://t.me/username'
                  : 'https://…'
            }
          />
        </div>
      ))}
      {config.messengers.length < 8 ? (
        <Button type="button" variant="outline" onClick={add} className="gap-1.5">
          <Plus className="size-4" />
          Добавить мессенджер
        </Button>
      ) : null}
    </div>
  )
}
