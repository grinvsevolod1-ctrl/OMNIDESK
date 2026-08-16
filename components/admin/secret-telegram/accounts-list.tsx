'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  AtSign,
  Loader2,
  MessageCircle,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  personalDeleteAction,
  personalGetProfileAction,
  personalRenameAction,
  personalSetUsernameAction,
  personalStartAction,
  personalStartDialogAction,
  personalStopAction,
  personalUpdateProfileAction,
  type PersonalAccountItem,
} from '@/app/actions/admin-secret/telegram-personal'
import { AccountConnectDialog } from './account-connect'

const STATUS_META: Record<
  string,
  { label: string; dot: string }
> = {
  online: { label: 'В сети', dot: 'bg-emerald-500' },
  starting: { label: 'Подключение…', dot: 'bg-amber-500 animate-pulse' },
  waiting_qr: { label: 'Ожидает QR', dot: 'bg-sky-500 animate-pulse' },
  waiting_code: { label: 'Ожидает код', dot: 'bg-sky-500 animate-pulse' },
  waiting_password: { label: 'Ожидает 2FA', dot: 'bg-sky-500 animate-pulse' },
  offline: { label: 'Не в сети', dot: 'bg-muted-foreground/50' },
  error: { label: 'Ошибка', dot: 'bg-destructive' },
}

/**
 * Список личных аккаунтов: карточка = аккаунт, клик — открыть мессенджер.
 * Управление жизненным циклом (стоп/старт/удалить) — в меню карточки.
 */
export function AccountsList({
  accounts,
  onOpen,
  onRefresh,
  refreshing,
}: {
  accounts: PersonalAccountItem[]
  onOpen: (account: PersonalAccountItem) => void
  onRefresh: () => void
  refreshing: boolean
}) {
  const [connectOpen, setConnectOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<PersonalAccountItem | null>(null)
  const [settingsFor, setSettingsFor] = useState<PersonalAccountItem | null>(null)
  const [writingFor, setWritingFor] = useState<PersonalAccountItem | null>(null)
  const [, startTransition] = useTransition()

  const run = (id: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusyId(id)
    startTransition(async () => {
      const res = await fn()
      setBusyId(null)
      if (res.ok) {
        toast.success(res.message)
        onRefresh()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Telegram</h2>
          <p className="text-sm text-muted-foreground">
            Личные аккаунты — переписка читается напрямую из Telegram и нигде
            не сохраняется.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="size-9 bg-transparent"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Обновить"
          >
            <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
          </Button>
          <Button onClick={() => setConnectOpen(true)}>
            <Plus className="size-4" />
            Подключить
          </Button>
        </div>
      </div>

      {accounts.length === 0 ? (
        <Card className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted">
            <MessageCircle className="size-6 text-muted-foreground" />
          </div>
          <div>
            <p className="font-medium">Нет подключённых аккаунтов</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground text-pretty">
              Подключите личный Telegram-аккаунт по QR-коду или номеру
              телефона, чтобы общаться прямо отсюда.
            </p>
          </div>
          <Button onClick={() => setConnectOpen(true)}>
            <Plus className="size-4" />
            Подключить аккаунт
          </Button>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {accounts.map((a) => {
            const meta = STATUS_META[a.sessionStatus] ?? STATUS_META.offline
            const busy = busyId === a.id
            return (
              <Card key={a.id} className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{a.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {a.phone ?? a.detail ?? '—'}
                    </p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 shrink-0"
                          aria-label="Действия"
                          disabled={busy}
                        >
                          {busy ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <MoreVertical className="size-4" />
                          )}
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      {a.sessionStatus === 'online' ? (
                        <DropdownMenuItem
                          onClick={() => run(a.id, () => personalStopAction(a.id))}
                        >
                          <Pause className="size-4" />
                          Отключить
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          onClick={() => run(a.id, () => personalStartAction(a.id))}
                        >
                          <Play className="size-4" />
                          Подключить
                        </DropdownMenuItem>
                      )}
                      {a.sessionStatus === 'online' && (
                        <>
                          <DropdownMenuItem onClick={() => setWritingFor(a)}>
                            <Send className="size-4" />
                            Написать первым
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setSettingsFor(a)}>
                            <Settings2 className="size-4" />
                            Настройки Telegram
                          </DropdownMenuItem>
                        </>
                      )}
                      <DropdownMenuItem onClick={() => setRenaming(a)}>
                        <Pencil className="size-4" />
                        Переименовать в панели
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => {
                          if (
                            confirm(
                              'Удалить аккаунт из панели? Авторизация в Telegram будет завершена.',
                            )
                          ) {
                            run(a.id, () => personalDeleteAction(a.id))
                          }
                        }}
                      >
                        <Trash2 className="size-4" />
                        Удалить
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className={cn('size-2 rounded-full', meta.dot)} />
                  {meta.label}
                  {a.sessionStatus === 'error' && a.lastError && (
                    <span className="truncate" title={a.lastError}>
                      — {a.lastError}
                    </span>
                  )}
                </div>
                <Button
                  variant="secondary"
                  className="w-full"
                  disabled={a.sessionStatus !== 'online'}
                  onClick={() => onOpen(a)}
                >
                  <MessageCircle className="size-4" />
                  Открыть чаты
                </Button>
              </Card>
            )
          })}
        </div>
      )}

      <AccountConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={onRefresh}
      />

      <RenameDialog
        key={renaming?.id ?? 'closed'}
        account={renaming}
        onOpenChange={(open) => {
          if (!open) setRenaming(null)
        }}
        onRenamed={onRefresh}
      />

      <SettingsDialog
        key={settingsFor ? `s-${settingsFor.id}` : 's-closed'}
        account={settingsFor}
        onOpenChange={(open) => {
          if (!open) setSettingsFor(null)
        }}
        onSaved={onRefresh}
      />

      <StartDialog
        key={writingFor ? `w-${writingFor.id}` : 'w-closed'}
        account={writingFor}
        onOpenChange={(open) => {
          if (!open) setWritingFor(null)
        }}
        onStarted={(account) => onOpen(account)}
      />
    </div>
  )
}

/** Диалог переименования аккаунта — меняет только имя карточки в панели. */
function RenameDialog({
  account,
  onOpenChange,
  onRenamed,
}: {
  account: PersonalAccountItem | null
  onOpenChange: (open: boolean) => void
  onRenamed: () => void
}) {
  // Компонент пересоздаётся по key={account.id} — стейт стартует с текущего имени.
  const [name, setName] = useState(account?.name ?? '')
  const [pending, startTransition] = useTransition()

  const submit = () => {
    if (!account) return
    const trimmed = name.trim()
    if (!trimmed) return
    startTransition(async () => {
      const res = await personalRenameAction(account.id, trimmed)
      if (res.ok) {
        toast.success(res.message)
        onRenamed()
        onOpenChange(false)
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog open={account !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Переименовать аккаунт</DialogTitle>
          <DialogDescription>
            Имя отображается только в панели — профиль в Telegram не меняется.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              )
                submit()
            }}
            placeholder={account?.name ?? 'Название аккаунта'}
            maxLength={100}
            autoFocus
            aria-label="Новое имя аккаунта"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" className="bg-transparent" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button onClick={submit} disabled={pending || !name.trim()}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Сохранить
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Настройки Telegram-профиля: имя, фамилия, @username, «о себе». Это НАСТОЯЩЕЕ
 * изменение аккаунта в Telegram (username сохраняется отдельным запросом, т.к.
 * у него свои ошибки — «занят»/«недопустим»).
 */
function SettingsDialog({
  account,
  onOpenChange,
  onSaved,
}: {
  account: PersonalAccountItem | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [username, setUsername] = useState('')
  const [about, setAbout] = useState('')
  const [initialUsername, setInitialUsername] = useState('')
  const [pending, startTransition] = useTransition()

  // Загружаем живой профиль из Telegram при открытии.
  useEffect(() => {
    if (!account) return
    let cancelled = false
    setLoading(true)
    personalGetProfileAction(account.id).then((res) => {
      if (cancelled) return
      if (res.ok && res.profile) {
        setFirstName(res.profile.firstName)
        setLastName(res.profile.lastName)
        setUsername(res.profile.username ?? '')
        setInitialUsername(res.profile.username ?? '')
        setAbout(res.profile.about)
      } else {
        toast.error(res.error ?? 'Не удалось загрузить профиль.')
        onOpenChange(false)
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [account, onOpenChange])

  const submit = () => {
    if (!account) return
    if (!firstName.trim()) {
      toast.error('Имя не может быть пустым.')
      return
    }
    startTransition(async () => {
      // 1. Имя/фамилия/«о себе».
      const prof = await personalUpdateProfileAction(account.id, {
        firstName,
        lastName,
        about,
      })
      if (!prof.ok) {
        toast.error(prof.message)
        return
      }
      // 2. @username — только если менялся (у него отдельные ошибки).
      if (username.trim().replace(/^@/, '') !== initialUsername) {
        const uname = await personalSetUsernameAction(account.id, username)
        if (!uname.ok) {
          toast.error(uname.message)
          return
        }
      }
      toast.success('Профиль Telegram обновлён.')
      onSaved()
      onOpenChange(false)
    })
  }

  return (
    <Dialog open={account !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Настройки Telegram</DialogTitle>
          <DialogDescription>
            Изменяет профиль прямо в Telegram: имя, фамилию, @username и «о
            себе».
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Загружаем профиль…
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tg-first">Имя</Label>
                <Input
                  id="tg-first"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  maxLength={64}
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tg-last">Фамилия</Label>
                <Input
                  id="tg-last"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  maxLength={64}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tg-username">Имя пользователя</Label>
              <div className="relative">
                <AtSign className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="tg-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="username"
                  className="pl-8"
                  maxLength={32}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                5–32 символа: латиница, цифры и _. Пусто — снять username.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tg-about">О себе</Label>
              <Textarea
                id="tg-about"
                value={about}
                onChange={(e) => setAbout(e.target.value)}
                maxLength={70}
                rows={2}
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            className="bg-transparent"
            onClick={() => onOpenChange(false)}
          >
            Отмена
          </Button>
          <Button onClick={submit} disabled={pending || loading}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * «Написать первым»: инициирует диалог с новым человеком по @username или
 * номеру телефона. После отправки открывает созданный диалог в мессенджере.
 */
function StartDialog({
  account,
  onOpenChange,
  onStarted,
}: {
  account: PersonalAccountItem | null
  onOpenChange: (open: boolean) => void
  onStarted: (account: PersonalAccountItem) => void
}) {
  const [target, setTarget] = useState('')
  const [text, setText] = useState('')
  const [pending, startTransition] = useTransition()

  const submit = () => {
    if (!account) return
    if (!target.trim() || !text.trim()) return
    startTransition(async () => {
      const res = await personalStartDialogAction(account.id, target, text)
      if (res.ok) {
        toast.success(res.message)
        onOpenChange(false)
        onStarted(account)
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog open={account !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Написать первым</DialogTitle>
          <DialogDescription>
            Начните диалог с новым человеком по @username или номеру телефона.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sd-target">Кому</Label>
            <Input
              id="sd-target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="@username или +79991234567"
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sd-text">Первое сообщение</Label>
            <Textarea
              id="sd-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Здравствуйте!"
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            className="bg-transparent"
            onClick={() => onOpenChange(false)}
          >
            Отмена
          </Button>
          <Button
            onClick={submit}
            disabled={pending || !target.trim() || !text.trim()}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Отправить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
