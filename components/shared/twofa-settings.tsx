'use client'

import { useState, useTransition } from 'react'
import { Check, Copy, Loader2, ShieldCheck, ShieldOff } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Self-service 2FA card for manager and curator Settings → Security.
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
      <div className="flex flex-wrap items-center gap-2">
        {enabled ? (
          <ShieldCheck className="size-4 text-primary" aria-hidden />
        ) : (
          <ShieldOff className="size-4 text-muted-foreground" aria-hidden />
        )}
        <span className="text-sm">{METHOD_LABEL[status.method]}</span>
        {enabled && (
          <Badge variant="secondary">
            Резервных кодов: {status.backupCodesLeft}
          </Badge>
        )}
        {status.method === 'telegram' && (
          <Badge variant="secondary">
            Получателей: {status.telegramRecipients}
          </Badge>
        )}
      </div>

      {wizard.kind === 'backup' && (
        <BackupCodes codes={wizard.codes} onDone={() => setWizard({ kind: 'none' })} />
      )}

      {!enabled && wizard.kind === 'none' && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={startTotp} disabled={pending}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Приложение-аутентификатор
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              setWizard({
                kind: 'telegram',
                token: '',
                botUsername: '',
                chats: [],
                selected: [],
                challengeId: null,
              })
            }
          >
            Telegram-бот
          </Button>
        </div>
      )}

      {wizard.kind === 'totp' && (
        <div className="flex max-w-sm flex-col gap-3 rounded-lg border p-4">
          <p className="text-sm text-muted-foreground">
            Отсканируйте QR-код в приложении (Google Authenticator, 1Password и
            т.п.) и введите код из него.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element -- локальный data: URL, next/image не нужен */}
          <img
            src={wizard.qrDataUrl}
            alt="QR-код для приложения-аутентификатора"
            className="size-48 self-center rounded-md bg-white p-2"
          />
          <p className="break-all text-center font-mono text-xs text-muted-foreground">
            {wizard.secret}
          </p>
          <form action={confirmTotp} className="flex gap-2">
            <Input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123 456"
              maxLength={7}
              required
              aria-label="Код из приложения"
            />
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : 'Включить'}
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
      )}

      {wizard.kind === 'telegram' && (
        <div className="flex max-w-md flex-col gap-3 rounded-lg border p-4">
          {!wizard.botUsername ? (
            <>
              <p className="text-sm text-muted-foreground">
                Создайте своего бота в @BotFather и вставьте его токен. Бот
                принадлежит вам — панель хранит токен в зашифрованном виде.
              </p>
              <form action={checkToken} className="flex gap-2">
                <Input
                  name="token"
                  placeholder="1234567890:AAE…"
                  autoComplete="off"
                  required
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
              <p className="text-sm">
                Бот <span className="font-medium">@{wizard.botUsername}</span>.
                Напишите ему /start в Telegram, затем найдите свой ID.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={discoverChats}
                  disabled={pending}
                >
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
                      className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                        wizard.selected.includes(c.chatId)
                          ? 'border-primary bg-primary/10'
                          : 'hover:bg-accent'
                      }`}
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
                <form action={confirmTelegram} className="flex gap-2">
                  <Input
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="Код из Telegram"
                    maxLength={7}
                    required
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
        </div>
      )}

      {enabled && wizard.kind === 'none' && (
        <form action={disable} className="flex max-w-sm flex-col gap-2">
          <Label htmlFor="twofa-disable-password">
            Отключить — подтвердите текущим паролем
          </Label>
          <div className="flex gap-2">
            <Input
              id="twofa-disable-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                'Отключить'
              )}
            </Button>
          </div>
        </form>
      )}
    </div>
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
    <div className="flex max-w-sm flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 p-4">
      <p className="text-sm font-medium">
        Резервные коды — сохраните их сейчас
      </p>
      <p className="text-xs text-muted-foreground">
        Каждый код одноразовый и подходит вместо кода из
        приложения/Telegram. Больше они не будут показаны.
      </p>
      <div className="grid grid-cols-2 gap-1 font-mono text-sm">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="flex gap-2">
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
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? 'Скопировано' : 'Скопировать все'}
        </Button>
        <Button size="sm" onClick={onDone}>
          Готово
        </Button>
      </div>
    </div>
  )
}
