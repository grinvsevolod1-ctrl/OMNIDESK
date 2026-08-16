'use client'

/**
 * Управление безопасностью сотрудника в god-панели: сброс 2FA и выдача/показ
 * временного пароля. Вынесено из managers-tab.tsx.
 * Часть god-панели — инварианты AGENTS.md §4.
 */

import { useState } from 'react'
import { toast } from 'sonner'
import {
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Trash2,
} from 'lucide-react'
import {
  secretClearManagerTempPasswordAction,
  secretGetManagerTwofaAction,
  secretResetManagerTwofaAction,
  secretRevealManagerTempPasswordAction,
  secretSetManagerTempPasswordAction,
  type ManagerTwofaInfo,
} from '@/app/actions/admin-secret'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { Manager } from '@/lib/types'
import { copyText } from './utils'

/* ------------------------------- 2FA ---------------------------------- */

const TWOFA_METHOD_LABEL: Record<string, string> = {
  off: 'Выключена',
  totp: 'Приложение-аутентификатор',
  telegram: 'Telegram-бот',
}

/**
 * Per-employee 2FA control for the God panel. Shows the current method and
 * counters (secrets are never returned to the client) and lets the owner
 * forcibly remove 2FA — the recovery path when an employee lost their phone
 * or deleted their Telegram bot. The account password stays untouched.
 */
export function ManagerTwofa({ manager }: { manager: Manager }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<ManagerTwofaInfo | null>(null)

  async function load() {
    setLoading(true)
    try {
      const res = await secretGetManagerTwofaAction(manager.id)
      if (res.ok) setInfo(res)
      else toast.error(res.message)
    } catch {
      toast.error('Не удалось загрузить статус 2FA')
    } finally {
      setLoading(false)
    }
  }

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      setInfo(null)
      void load()
    }
  }

  function handleReset() {
    setBusy(true)
    ;(async () => {
      try {
        const res = await secretResetManagerTwofaAction(manager.id)
        if (res.ok) {
          toast.success(res.message)
          setInfo((prev) =>
            prev
              ? {
                  ...prev,
                  method: 'off',
                  enabledAt: null,
                  backupCodesLeft: 0,
                  telegramRecipients: 0,
                }
              : prev,
          )
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Не удалось удалить 2FA')
      } finally {
        setBusy(false)
      }
    })()
  }

  const enabled = info?.method === 'totp' || info?.method === 'telegram'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => onOpenChange(true)}
      >
        <ShieldCheck className="size-3.5" />
        2FA
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Двухфакторная защита</DialogTitle>
          <DialogDescription>
            {manager.name} — принудительное удаление 2FA на случай потери
            телефона или бота. Пароль аккаунта не меняется, сотрудник сможет
            включить защиту заново в своих настройках.
          </DialogDescription>
        </DialogHeader>

        {loading || !info ? (
          <div className="flex h-24 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Загрузка…
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div
              className={cn(
                'flex items-center gap-3 rounded-lg border p-3',
                enabled
                  ? 'border-success/40 bg-success/5'
                  : 'border-border bg-muted/30',
              )}
            >
              {enabled ? (
                <ShieldCheck className="size-5 shrink-0 text-success" />
              ) : (
                <ShieldOff className="size-5 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {TWOFA_METHOD_LABEL[info.method ?? 'off']}
                </p>
                {info.enabledAt ? (
                  <p className="text-xs text-muted-foreground">
                    Включена: {new Date(info.enabledAt).toLocaleString('ru-RU')}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Вход только по паролю
                  </p>
                )}
              </div>
            </div>

            {enabled && (
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">
                  Резервных кодов: {info.backupCodesLeft ?? 0}
                </Badge>
                {info.method === 'telegram' && (
                  <Badge variant="secondary">
                    Получателей: {info.telegramRecipients ?? 0}
                  </Badge>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            className="gap-1.5"
            disabled={busy || loading || !enabled}
            onClick={handleReset}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ShieldOff className="size-4" />
            )}
            Удалить 2FA
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* -------------------------- Temp password ----------------------------- */

/**
 * Per-manager temporary-password control. Opens a dialog that reveals the
 * current temp password (fetched on demand, decrypted server-side), and lets an
 * admin generate a new one, set a custom one, or clear it. This is a SEPARATE
 * credential from the manager's real password (which is a one-way bcrypt hash
 * and can never be shown) — see scripts/079_manager_temp_password.sql.
 */
export function ManagerTempPassword({ manager }: { manager: Manager }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [password, setPassword] = useState<string | null>(null)
  const [setAt, setSetAt] = useState<string | null>(null)
  const [reveal, setReveal] = useState(false)
  const [custom, setCustom] = useState('')

  async function load() {
    setLoading(true)
    try {
      const res = await secretRevealManagerTempPasswordAction(manager.id)
      if (res.ok) {
        setPassword(res.password ?? null)
        setSetAt(res.setAt ?? null)
      } else {
        toast.error(res.message)
      }
    } catch {
      toast.error('Не удалось загрузить пароль')
    } finally {
      setLoading(false)
    }
  }

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      setReveal(false)
      setCustom('')
      void load()
    }
  }

  function handleSet(customValue?: string) {
    setBusy(true)
    ;(async () => {
      try {
        const res = await secretSetManagerTempPasswordAction({
          managerId: manager.id,
          password: customValue,
        })
        if (res.ok) {
          setPassword(res.password ?? null)
          setSetAt(res.setAt ?? null)
          setReveal(true)
          setCustom('')
          toast.success(res.message)
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Не удалось сохранить пароль')
      } finally {
        setBusy(false)
      }
    })()
  }

  function handleClear() {
    setBusy(true)
    ;(async () => {
      try {
        const res = await secretClearManagerTempPasswordAction(manager.id)
        if (res.ok) {
          setPassword(null)
          setSetAt(null)
          toast.success(res.message)
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Не удалось удалить пароль')
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => onOpenChange(true)}
      >
        <KeyRound className="size-3.5" />
        Пароль
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Временный пароль</DialogTitle>
          <DialogDescription>
            {manager.name} — дополнительный пароль для входа, не связанный с
            основным. Основной пароль хранится в виде необратимого хеша и не может
            быть показан.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Текущий временный пароль</Label>
            {loading ? (
              <div className="flex h-10 items-center gap-2 rounded-md border border-border px-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Загрузка…
              </div>
            ) : password ? (
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={
                    reveal ? password : '•'.repeat(Math.min(password.length, 16))
                  }
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setReveal((v) => !v)}
                  aria-label={reveal ? 'Скрыть' : 'Показать'}
                >
                  {reveal ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => copyText(password)}
                  aria-label="Скопировать"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            ) : (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
                Временный пароль не задан.
              </p>
            )}
            {setAt ? (
              <p className="text-xs text-muted-foreground">
                Установлен: {new Date(setAt).toLocaleString('ru-RU')}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`custom-${manager.id}`}>Задать свой пароль</Label>
            <div className="flex items-center gap-2">
              <Input
                id={`custom-${manager.id}`}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="Минимум 6 символов"
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                disabled={busy || custom.trim().length < 6}
                onClick={() => handleSet(custom.trim())}
              >
                Сохранить
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="outline"
            className="gap-1.5 text-destructive"
            disabled={busy || !password}
            onClick={handleClear}
          >
            <Trash2 className="size-4" />
            Удалить
          </Button>
          <Button
            type="button"
            className="gap-1.5"
            disabled={busy}
            onClick={() => handleSet(undefined)}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Сгенерировать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
