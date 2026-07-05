'use client'

import { useState, useTransition } from 'react'
import {
  CheckCircle2,
  KeyRound,
  Loader2,
  Trash2,
  TriangleAlert,
  Video,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  checkTelemostTokenAction,
  clearTelemostTokenAction,
  saveTelemostConfigAction,
} from '@/app/actions/telemost'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
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

export interface TelemostAdminStatus {
  configured: boolean
  enabled: boolean
  waitingRoomLevel: 'PUBLIC' | 'ORGANIZATION' | 'ADMINISTRATOR'
  tokenMask: string | null
}

const LEVEL_LABELS: Record<TelemostAdminStatus['waitingRoomLevel'], string> = {
  PUBLIC: 'Публичный — вход по ссылке без ожидания',
  ORGANIZATION: 'Только сотрудники организации',
  ADMINISTRATOR: 'С одобрения организатора (зал ожидания)',
}

export function TelemostAdmin({ status }: { status: TelemostAdminStatus }) {
  const [token, setToken] = useState('')
  const [level, setLevel] = useState<TelemostAdminStatus['waitingRoomLevel']>(
    status.waitingRoomLevel,
  )
  const [enabled, setEnabled] = useState(status.enabled)
  const [saving, startSave] = useTransition()
  const [checking, startCheck] = useTransition()
  const [clearing, startClear] = useTransition()

  function save() {
    if (!status.configured && !token.trim()) {
      toast.error('Укажите OAuth-токен Яндекс Телемост.')
      return
    }
    startSave(async () => {
      const res = await saveTelemostConfigAction({
        token: token.trim(),
        waitingRoomLevel: level,
        enabled,
      })
      if (res.ok) {
        toast.success(res.message)
        setToken('')
      } else {
        toast.error(res.message)
      }
    })
  }

  function check() {
    startCheck(async () => {
      const res = await checkTelemostTokenAction()
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
    })
  }

  function clearToken() {
    startClear(async () => {
      const res = await clearTelemostTokenAction()
      if (res.ok) {
        toast.success(res.message)
        setEnabled(false)
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-5 p-5">
        <div className="flex items-center gap-2">
          <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-muted/40">
            <KeyRound className="size-4 text-muted-foreground" />
          </div>
          <div>
            <h2 className="font-medium">Подключение Яндекс Телемост</h2>
            <p className="text-xs text-muted-foreground">
              OAuth-токен из Яндекс 360. Хранится в зашифрованном виде.
            </p>
          </div>
          <span
            className={
              status.configured
                ? 'ml-auto inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/5 px-2.5 py-1 text-xs text-success'
                : 'ml-auto inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/5 px-2.5 py-1 text-xs text-warning'
            }
          >
            {status.configured ? 'Подключено' : 'Не подключено'}
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="tm-token">
            OAuth-токен
            {status.configured && status.tokenMask ? (
              <span className="ml-2 font-mono text-xs text-muted-foreground">
                (текущий: {status.tokenMask})
              </span>
            ) : null}
          </Label>
          <Input
            id="tm-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={
              status.configured
                ? 'Введите заново, чтобы заменить'
                : 'y0_AgAAAA... токен с правом telemost-api'
            }
            className="font-mono text-sm"
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            Создайте приложение на{' '}
            <a
              href="https://oauth.yandex.ru"
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline underline-offset-2"
            >
              oauth.yandex.ru
            </a>{' '}
            с правом «Телемост: создание конференций» и получите токен.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="tm-level">Кто может входить во встречу</Label>
            <Select
              value={level}
              onValueChange={(v) =>
                setLevel(v as TelemostAdminStatus['waitingRoomLevel'])
              }
            >
              <SelectTrigger id="tm-level">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(
                  Object.keys(LEVEL_LABELS) as TelemostAdminStatus['waitingRoomLevel'][]
                ).map((k) => (
                  <SelectItem key={k} value={k}>
                    {LEVEL_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Функция включена</p>
              <p className="text-xs text-muted-foreground">
                Показывать менеджерам кнопку видеовстречи.
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={!status.configured && !token.trim()}
              aria-label="Включить Телемост"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={save} disabled={saving} className="w-full sm:w-auto">
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Сохранить настройки
          </Button>
          {status.configured ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={check}
                disabled={checking}
              >
                {checking ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-4" />
                )}
                Проверить токен
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={clearToken}
                disabled={clearing}
                className="text-destructive hover:text-destructive"
              >
                {clearing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
                Отключить
              </Button>
            </>
          ) : null}
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2">
          <Video className="size-4 text-muted-foreground" />
          <h2 className="font-medium">Как это работает</h2>
        </div>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Телемост — сервис видеовстреч (не мессенджер). Менеджер создаёт
            встречу из диалога или на вкладке «Видеовстречи», а ссылка
            отправляется клиенту через тот канал, в котором идёт переписка.
          </p>
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              Токен общий для всех менеджеров. Держите его в секрете — любой с
              этим токеном может создавать встречи от имени организации.
            </span>
          </div>
        </div>
      </Card>
    </div>
  )
}
