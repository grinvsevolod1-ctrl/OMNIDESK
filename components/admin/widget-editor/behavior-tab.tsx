'use client'

import { Smartphone } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Field, type TabProps } from './shared'

export function BehaviorTab({ config, patch }: TabProps) {
  const ao = config.autoOpen
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-medium">Авто-открытие чата</p>
          <p className="text-xs text-muted-foreground">
            Автоматически разворачивать окно через заданное время после загрузки
            страницы.
          </p>
        </div>
        <Switch
          checked={ao.enabled}
          onCheckedChange={(v) =>
            patch((d) => void (d.autoOpen.enabled = Boolean(v)))
          }
        />
      </div>
      {ao.enabled ? (
        <Field label="Задержка перед открытием (секунды)">
          <Input
            type="number"
            min={1}
            max={600}
            value={ao.delaySec}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10)
              patch(
                (d) =>
                  void (d.autoOpen.delaySec = Number.isFinite(n)
                    ? Math.min(600, Math.max(1, n))
                    : 15),
              )
            }}
          />
        </Field>
      ) : null}

      <div className="flex items-start gap-2 rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
        <Smartphone className="mt-0.5 size-4 shrink-0" />
        <span>
          Авто-открытие срабатывает один раз за сессию и только в рабочее время.
          В превью оно отключено, чтобы не мешать настройке.
        </span>
      </div>
    </div>
  )
}
