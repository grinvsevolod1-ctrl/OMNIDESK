'use client'

/**
 * Диалоги управления личным Telegram-аккаунтом (god-панель, вкладка «Telegram»):
 * переименование карточки, настройки профиля в Telegram, «написать первым».
 * Вынесено из accounts-list.tsx. Часть god-панели — инварианты AGENTS.md §4.
 */

import { useCallback, useEffect, useState, useTransition } from 'react'
import {
  AtSign,
  Loader2,
  Monitor,
  MonitorSmartphone,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
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
import { Textarea } from '@/components/ui/textarea'
import {
  personalGetProfileAction,
  personalRenameAction,
  personalResetSessionAction,
  personalSessionsAction,
  personalSetUsernameAction,
  personalStartDialogAction,
  personalUpdateProfileAction,
  type PersonalAccountItem,
  type PersonalSessionItem,
} from '@/app/actions/admin-secret/telegram-personal'

/** Диалог переименования аккаунта — меняет только имя карточки в панели. */
export function RenameDialog({
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
export function SettingsDialog({
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

  // Загружаем живой профиль из Telegram при открытии. Диалог пересоздаётся по
  // key={`s-${account.id}`} на месте вызова, поэтому `loading` уже стартует с
  // true при каждом новом аккаунте — синхронный setState в эффекте не нужен.
  useEffect(() => {
    if (!account) return
    let cancelled = false
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
            Изменяет профиль прямо в Telegram: имя, фамилия, @username и «о
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
export function StartDialog({
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

/** Иконка устройства по платформе/модели сессии. */
function deviceIcon(session: PersonalSessionItem) {
  const p = `${session.platform} ${session.systemVersion} ${session.deviceModel}`.toLowerCase()
  if (/android|ios|iphone|ipad|mobile|phone/.test(p)) return Smartphone
  if (/desktop|windows|macos|mac os|linux|tdesktop/.test(p)) return Monitor
  return MonitorSmartphone
}

/** Человекочитаемое «последняя активность»: только что / N мин / дата. */
function formatActive(unixSec: number): string {
  if (!unixSec) return '—'
  const diffMs = Date.now() - unixSec * 1000
  const min = Math.floor(diffMs / 60_000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин назад`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} ч назад`
  return new Date(unixSec * 1000).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Активные сессии аккаунта: живой список авторизаций из Telegram
 * (account.getAuthorizations) с возможностью завершить любую чужую
 * (account.resetAuthorization). Текущая сессия помечается и не завершается —
 * Telegram запрещает reset собственной авторизации. Требует online-сессию.
 */
export function SessionsDialog({
  account,
  onOpenChange,
}: {
  account: PersonalAccountItem | null
  onOpenChange: (open: boolean) => void
}) {
  const [loading, setLoading] = useState(true)
  const [sessions, setSessions] = useState<PersonalSessionItem[]>([])
  const [resettingHash, setResettingHash] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const load = useCallback(() => {
    if (!account) return
    const accountId = account.id
    startTransition(async () => {
      const res = await personalSessionsAction(accountId)
      if (res.ok) {
        setSessions(res.sessions)
      } else {
        toast.error(res.error ?? 'Не удалось загрузить сессии.')
        setSessions([])
      }
      setLoading(false)
    })
  }, [account])

  // Диалог пересоздаётся по key на месте вызова, поэтому загрузка стартует
  // при каждом новом аккаунте. startTransition уводит setState из тела эффекта.
  useEffect(() => {
    load()
  }, [load])

  const reset = (session: PersonalSessionItem) => {
    if (!account) return
    if (
      !confirm(
        `Завершить сессию «${session.deviceModel || session.appName || 'устройство'}»? Устройство выйдет из аккаунта.`,
      )
    ) {
      return
    }
    setResettingHash(session.hash)
    startTransition(async () => {
      const res = await personalResetSessionAction(account.id, session.hash)
      setResettingHash(null)
      if (res.ok) {
        toast.success(res.message)
        setSessions((prev) => prev.filter((s) => s.hash !== session.hash))
      } else {
        toast.error(res.message)
      }
    })
  }

  const others = sessions.filter((s) => !s.current).length

  return (
    <Dialog open={account !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Активные сессии</DialogTitle>
          <DialogDescription>
            Устройства, на которых сейчас выполнен вход в этот аккаунт Telegram.
            Любую чужую сессию можно завершить.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Загружаем сессии…
          </div>
        ) : sessions.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Активных сессий не найдено.
          </div>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto pr-1">
            {sessions.map((s) => {
              const Icon = deviceIcon(s)
              const busy = resettingHash === s.hash
              const location = [s.country, s.region].filter(Boolean).join(', ')
              return (
                <div
                  key={s.hash}
                  className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
                >
                  <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Icon className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-medium">
                        {s.deviceModel || s.appName || 'Устройство'}
                      </p>
                      {s.current && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                          <ShieldCheck className="size-3" />
                          Текущая
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {[s.appName, s.appVersion].filter(Boolean).join(' ')}
                      {s.platform ? ` · ${s.platform}` : ''}
                      {s.systemVersion ? ` ${s.systemVersion}` : ''}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {[s.ip, location].filter(Boolean).join(' · ') || '—'}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Активность: {formatActive(s.dateActive)}
                    </p>
                  </div>
                  {!s.current && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => reset(s)}
                      disabled={busy}
                      aria-label="Завершить сессию"
                      title="Завершить сессию"
                    >
                      {busy ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <X className="size-4" />
                      )}
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {loading
              ? ''
              : `Всего: ${sessions.length}${others > 0 ? ` · других: ${others}` : ''}`}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="bg-transparent"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} />
              Обновить
            </Button>
            <Button onClick={() => onOpenChange(false)}>Закрыть</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
