'use client'

/** Мастер включения 2FA через собственного Telegram-бота. */
import { Loader2, QrCode } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { WizardStep, type Wizard } from './shared'

type TelegramWizardState = Extract<Wizard, { kind: 'telegram' }>

export function TelegramWizard({
  wizard,
  pending,
  onCheckToken,
  onDiscoverChats,
  onToggleChat,
  onAddManualChat,
  onSendCode,
  onConfirm,
  onCancel,
}: {
  wizard: TelegramWizardState
  pending: boolean
  onCheckToken: (formData: FormData) => void
  onDiscoverChats: () => void
  onToggleChat: (chatId: string) => void
  onAddManualChat: (formData: FormData) => void
  onSendCode: () => void
  onConfirm: (formData: FormData) => void
  onCancel: () => void
}) {
  return (
    <Card className="flex flex-col gap-4 p-5">
      {!wizard.botUsername ? (
        <>
          <WizardStep n={1} title="Создайте бота и вставьте токен">
            Напишите @BotFather в Telegram, команда /newbot. Бот принадлежит
            вам — панель хранит токен в зашифрованном виде.
          </WizardStep>
          <form action={onCheckToken} className="flex max-w-md gap-2">
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
              onClick={onDiscoverChats}
              disabled={pending}
            >
              <QrCode className="size-3.5" aria-hidden />
              Найти мой ID
            </Button>
            <form action={onAddManualChat} className="flex gap-2">
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
                  onClick={() => onToggleChat(c.chatId)}
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
              onClick={onSendCode}
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
              <form action={onConfirm} className="flex max-w-xs gap-2">
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
        onClick={onCancel}
      >
        Отмена
      </Button>
    </Card>
  )
}
