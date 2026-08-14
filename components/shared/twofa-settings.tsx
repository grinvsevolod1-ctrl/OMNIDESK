'use client'

import { useState, useTransition } from 'react'
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  Lock,
  QrCode,
  Send,
  ShieldCheck,
  ShieldOff,
  Smartphone,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  checkBotTokenAction,
  confirmTelegramSetupAction,
  confirmTotpSetupAction,
  disableTwofaAction,
  discoverChatIdsAction,
  sendTelegramSetupCodeAction,
  startTotpSetupAction,
  type TwofaStatus,
} from '@/app/actions/twofa'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * Self-service 2FA page for manager and curator Settings → «2FA» tab.
 * Two enable wizards (TOTP authenticator app / own Telegram bot) and a
 * password-confirmed disable. Backup codes are displayed exactly once,
 * right after enabling — they are bcrypt-hashed server-side and can never
 * be shown again.
 */

type Wizard =
  | { kind: 'none' }
  | { kind: 'totp'; secret: string; qrDataUrl: string }
  | {
      kind: 'telegram'
      token: string
      botUsername: string
      chats: { chatId: string; name: string }[]
      selected: string[]
      challengeId: string | null
    }
  | { kind: 'backup'; codes: string[] }

const METHOD_LABEL: Record<TwofaStatus['method'], string> = {
  off: 'Выключена',
  totp: 'Приложение-аутентификатор',
  telegram: 'Telegram-бот',
}

export function TwofaSettings({ initial }: { initial: TwofaStatus }) {
  const [status, setStatus] = useState<TwofaStatus>(initial)
  const [wizard, setWizard] = useState<Wizard>({ kind: 'none' })
  const [pending, startTransition] = useTransition()

  const enabled = status.method !== 'off'

  function finishEnable(method: TwofaStatus['method'], codes: string[]) {
    setStatus((s) => ({
      ...s,
      method,
      enabledAt: new Date().toISOString(),
      backupCodesLeft: codes.length,
    }))
    setWizard({ kind: 'backup', codes })
  }

  /* ------------------------------ TOTP ------------------------------- */

  function startTotp() {
    startTransition(async () => {
      const res = await startTotpSetupAction()
      if (res.ok && res.secret && res.qrDataUrl) {
        setWizard({ kind: 'totp', secret: res.secret, qrDataUrl: res.qrDataUrl })
      } else {
        toast.error(res.message ?? 'Не удалось начать настройку.')
      }
    })
  }

  function confirmTotp(formData: FormData) {
    if (wizard.kind !== 'totp') return
    const code = String(formData.get('code') ?? '')
    startTransition(async () => {
      const res = await confirmTotpSetupAction(wizard.secret, code)
      if (res.ok && res.backupCodes) {
        toast.success('Двухфакторная защита включена.')
        finishEnable('totp', res.backupCodes)
      } else {
        toast.error(res.message ?? 'Не удалось подтвердить код.')
      }
    })
  }

  /* ---------------------------- Telegram ----------------------------- */

  function checkToken(formData: FormData) {
    const token = String(formData.get('token') ?? '').trim()
    startTransition(async () => {
      const res = await checkBotTokenAction(token)
      if (res.ok && res.botUsername) {
        setWizard({
          kind: 'telegram',
          token,
          botUsername: res.botUsername,
          chats: [],
          selected: [],
          challengeId: null,
        })
        toast.success(`Бот @${res.botUsername} подтверждён.`)
      } else {
        toast.error(res.message ?? 'Токен не принят.')
      }
    })
  }

  function discoverChats() {
    if (wizard.kind !== 'telegram') return
    startTransition(async () => {
      const res = await discoverChatIdsAction(wizard.token)
      if (res.ok && res.chats) {
        setWizard({ ...wizard, chats: res.chats })
      } else {
        toast.error(res.message ?? 'Чаты не найдены.')
      }
    })
  }

  function toggleChat(chatId: string) {
    if (wizard.kind !== 'telegram') return
    setWizard({
      ...wizard,
      selected: wizard.selected.includes(chatId)
        ? wizard.selected.filter((c) => c !== chatId)
        : [...wizard.selected, chatId],
    })
  }

  function addManualChat(formData: FormData) {
    if (wizard.kind !== 'telegram') return
    const id = String(formData.get('chatId') ?? '').trim()
    if (!/^-?\d{5,20}$/.test(id)) {
      toast.error('ID выглядит неверно — это число из Telegram.')
      return
    }
    if (wizard.selected.includes(id)) return
    setWizard({ ...wizard, selected: [...wizard.selected, id] })
  }

  function sendCode() {
    if (wizard.kind !== 'telegram') return
    startTransition(async () => {
      const res = await sendTelegramSetupCodeAction(
        wizard.token,
        wizard.selected,
      )
      if (res.ok && res.challengeId) {
        setWizard({ ...wizard, challengeId: res.challengeId })
        toast.success(res.message ?? 'Код отправлен.')
      } else {
        toast.error(res.message ?? 'Не удалось отправить код.')
      }
    })
  }

  function confirmTelegram(formData: FormData) {
    if (wizard.kind !== 'telegram' || !wizard.challengeId) return
    const code = String(formData.get('code') ?? '')
    startTransition(async () => {
      const res = await confirmTelegramSetupAction(
        wizard.challengeId as string,
        code,
        wizard.token,
        wizard.selected,
      )
      if (res.ok && res.backupCodes) {
        toast.success('Двухфакторная защита включена.')
        finishEnable('telegram', res.backupCodes)
      } else {
        toast.error(res.message ?? 'Не удалось подтвердить код.')
      }
    })
  }

  /* ----------------------------- Disable ----------------------------- */

  function disable(formData: FormData) {
    const password = String(formData.get('password') ?? '')
    startTransition(async () => {
      const res = await disableTwofaAction(password)
      if (res.ok) {
        toast.success(res.message)
        setStatus((s) => ({
          ...s,
          method: 'off',
          enabledAt: null,
          backupCodesLeft: 0,
          telegramRecipients: 0,
        }))
        setWizard({ kind: 'none' })
      } else {
        toast.error(res.message)
      }
    })
  }

  /* ------------------------------- UI -------------------------------- */

  return (
    <div className="flex flex-col gap-4">
      {/* ── Статус-карточка ── */}
      <Card className="relative overflow-hidden p-0">
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b to-transparent',
            enabled ? 'from-success/[0.08]' : 'from-muted/60',
          )}
        />
        <div className="relative flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
          <div
            className={cn(
              'flex size-14 shrink-0 items-center justify-center rounded-xl border',
              enabled
                ? 'border-success/30 bg-success/10 text-success'
                : 'border-border bg-muted/40 text-muted-foreground',
            )}
          >
            {enabled ? (
              <ShieldCheck className="size-7" aria-hidden />
            ) : (
              <ShieldOff className="size-7" aria-hidden />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold">
              {enabled ? 'Защита включена' : 'Защита выключена'}
            </p>
            <p className="text-sm text-muted-foreground">
              {enabled ? (
                <>
                  Метод: {METHOD_LABEL[status.method]}
                  {status.enabledAt &&
                    ` · с ${new Date(status.enabledAt).toLocaleDateString('ru-RU')}`}
                </>
              ) : (
                'Вход только по паролю. Добавьте второй фактор — даже украденный пароль не даст войти в аккаунт.'
              )}
            </p>
          </div>
          {enabled && (
            <div className="flex shrink-0 flex-wrap gap-2">
              <Badge variant="secondary" className="gap-1">
                <KeyRound className="size-3" aria-hidden />
                Резервных кодов: {status.backupCodesLeft}
              </Badge>
              {status.method === 'telegram' && (
                <Badge variant="secondary" className="gap-1">
                  <Send className="size-3" aria-hidden />
                  Получателей: {status.telegramRecipients}
                </Badge>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* ── Резервные коды (показываются один раз) ── */}
      {wizard.kind === 'backup' && (
        <BackupCodes
          codes={wizard.codes}
          onDone={() => setWizard({ kind: 'none' })}
        />
      )}

      {/* ── Выбор метода ── */}
      {!enabled && wizard.kind === 'none' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <MethodCard
            icon={Smartphone}
            title="Приложение-аутентификатор"
            badge="Рекомендуем"
            description="Google Authenticator, 1Password и другие. Работает без интернета — коды генерируются прямо на телефоне."
            actionLabel="Настроить"
            pending={pending}
            onStart={startTotp}
          />
          <MethodCard
            icon={Send}
            title="Telegram-бот"
            description="Создайте своего бота в @BotFather — коды входа будут приходить вам в Telegram. Токен хранится в зашифрованном виде."
            actionLabel="Подключить"
            pending={pending}
            onStart={() =>
              setWizard({
                kind: 'telegram',
                token: '',
                botUsername: '',
                chats: [],
                selected: [],
                challengeId: null,
              })
            }
          />
        </div>
      )}

      {/* ── Мастер: TOTP ── */}
      {wizard.kind === 'totp' && (
        <Card className="p-5">
          <div className="flex flex-col gap-5 sm:flex-row">
            <div className="flex shrink-0 flex-col items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- локальный data: URL, next/image не нужен */}
              <img
                src={wizard.qrDataUrl || '/placeholder.svg'}
                alt="QR-код для приложения-аутентификатора"
                className="size-44 rounded-lg bg-white p-2"
              />
              <p className="max-w-44 break-all text-center font-mono text-[11px] leading-tight text-muted-foreground">
                {wizard.secret}
              </p>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-4">
              <WizardStep n={1} title="Отсканируйте QR-код">
                Откройте приложение (Google Authenticator, 1Password и т.п.) и
                добавьте аккаунт по QR-коду. Если камера недоступна — введите
                секрет под кодом вручную.
              </WizardStep>
              <WizardStep n={2} title="Введите код из приложения">
                Приложение покажет 6-значный код, который обновляется каждые 30
                секунд.
              </WizardStep>
              <form action={confirmTotp} className="flex max-w-xs gap-2">
                <Input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123 456"
                  maxLength={7}
                  required
                  className="text-center font-mono tracking-widest"
                  aria-label="Код из приложения"
                />
                <Button type="submit" disabled={pending}>
                  {pending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    'Включить'
                  )}
                </Button>
              </form>
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => setWizard({ kind: 'none' })}
              >
                Отмена
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* ── Мастер: Telegram ── */}
      {wizard.kind === 'telegram' && (
        <Card className="flex flex-col gap-4 p-5">
          {!wizard.botUsername ? (
            <>
              <WizardStep n={1} title="Создайте бота и вставьте токен">
                Напишите @BotFather в Telegram, команда /newbot. Бот принадлежит
                вам — панель хранит токен в зашифрованном виде.
              </WizardStep>
              <form action={checkToken} className="flex max-w-md gap-2">
                <Input
                  name="token"
                  placeholder="1234567890:AAE…"
                  autoComplete="off"
                  required
                  className="font-mono"
                  aria-label="Токен бота"
                />
                <Button type="submit" disabled={pending}>
                  {pending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    'Проверить'
                  )}
                </Button>
              </form>
            </>
          ) : (
            <>
              <WizardStep n={2} title={`Бот @${wizard.botUsername} подтверждён`}>
                Напишите ему /start в Telegram, затем нажмите «Найти мой ID» —
                или добавьте ID вручную.
              </WizardStep>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={discoverChats}
                  disabled={pending}
                >
                  <QrCode className="size-3.5" aria-hidden />
                  Найти мой ID
                </Button>
                <form action={addManualChat} className="flex gap-2">
                  <Input
                    name="chatId"
                    placeholder="ID вручную"
                    className="h-8 w-32"
                    aria-label="Chat ID вручную"
                  />
                  <Button type="submit" variant="ghost" size="sm">
                    Добавить
                  </Button>
                </form>
              </div>
              {wizard.chats.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {wizard.chats.map((c) => (
                    <button
                      key={c.chatId}
                      type="button"
                      onClick={() => toggleChat(c.chatId)}
                      className={cn(
                        'rounded-md border px-2 py-1 text-xs transition-colors',
                        wizard.selected.includes(c.chatId)
                          ? 'border-primary bg-primary/10'
                          : 'hover:bg-accent',
                      )}
                    >
                      {c.name} ({c.chatId})
                    </button>
                  ))}
                </div>
              )}
              {wizard.selected.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Получатели: {wizard.selected.join(', ')}
                </p>
              )}
              {!wizard.challengeId ? (
                <Button
                  onClick={sendCode}
                  disabled={pending || wizard.selected.length === 0}
                  className="self-start"
                >
                  {pending && <Loader2 className="size-4 animate-spin" />}
                  Отправить код
                </Button>
              ) : (
                <>
                  <WizardStep n={3} title="Введите код из Telegram">
                    Бот прислал вам код подтверждения.
                  </WizardStep>
                  <form action={confirmTelegram} className="flex max-w-xs gap-2">
                    <Input
                      name="code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="Код из Telegram"
                      maxLength={7}
                      required
                      className="text-center font-mono tracking-widest"
                      aria-label="Код из Telegram"
                    />
                    <Button type="submit" disabled={pending}>
                      {pending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        'Включить'
                      )}
                    </Button>
                  </form>
                </>
              )}
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setWizard({ kind: 'none' })}
          >
            Отмена
          </Button>
        </Card>
      )}

      {/* ── Отключение ── */}
      {enabled && wizard.kind === 'none' && (
        <Card className="border-destructive/30 p-5">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-destructive/30 bg-destructive/10 text-destructive">
              <Lock className="size-4" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium">Отключить защиту</h3>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Второй фактор и резервные коды будут удалены. Подтвердите
                действие текущим паролем.
              </p>
              <form action={disable} className="mt-3 flex max-w-sm gap-2">
                <Input
                  id="twofa-disable-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Текущий пароль"
                  required
                  aria-label="Текущий пароль"
                />
                <Button type="submit" variant="destructive" disabled={pending}>
                  {pending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    'Отключить'
                  )}
                </Button>
              </form>
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}

/* ------------------------------ Pieces -------------------------------- */

/** Пронумерованный шаг мастера настройки. */
function WizardStep({
  n,
  title,
  children,
}: {
  n: number
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium leading-6">{title}</p>
        <p className="text-sm text-muted-foreground">{children}</p>
      </div>
    </div>
  )
}

/** Карточка выбора метода 2FA. */
function MethodCard({
  icon: Icon,
  title,
  badge,
  description,
  actionLabel,
  pending,
  onStart,
}: {
  icon: typeof Smartphone
  title: string
  badge?: string
  description: string
  actionLabel: string
  pending: boolean
  onStart: () => void
}) {
  return (
    <Card className="group flex flex-col gap-3 p-5 transition-colors hover:border-primary/40">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground transition-colors group-hover:border-primary/30 group-hover:bg-primary/10 group-hover:text-primary">
          <Icon className="size-5" aria-hidden />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">{title}</h3>
          {badge && (
            <Badge
              variant="outline"
              className="border-primary/30 bg-primary/5 text-primary"
            >
              {badge}
            </Badge>
          )}
        </div>
      </div>
      <p className="flex-1 text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      <Button
        onClick={onStart}
        disabled={pending}
        variant="outline"
        className="self-start bg-transparent"
      >
        {pending && <Loader2 className="size-4 animate-spin" />}
        {actionLabel}
      </Button>
    </Card>
  )
}

/** One-time backup-codes reveal with a copy-all button. */
function BackupCodes({
  codes,
  onDone,
}: {
  codes: string[]
  onDone: () => void
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Card className="border-primary/40 bg-primary/5 p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
          <KeyRound className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            Резервные коды — сохраните их сейчас
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Каждый код одноразовый и подходит вместо кода из
            приложения/Telegram. Больше они не будут показаны.
          </p>
          <div className="mt-3 grid max-w-xs grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border border-border bg-card p-3 font-mono text-sm">
            {codes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(codes.join('\n')).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                })
              }}
            >
              {copied ? (
                <Check className="size-4" />
              ) : (
                <Copy className="size-4" />
              )}
              {copied ? 'Скопировано' : 'Скопировать все'}
            </Button>
            <Button size="sm" onClick={onDone}>
              Готово
            </Button>
          </div>
        </div>
      </div>
    </Card>
  )
}
