'use client'

/**
 * Self-service 2FA page for manager and curator Settings → «2FA» tab.
 * КОНТЕЙНЕР: держит состояние (статус, текущий мастер) и все вызовы server
 * actions; вся вёрстка — в подпапке twofa-settings/ (паттерн «контейнер +
 * подпапка», см. AGENTS.md). Two enable wizards (TOTP authenticator app /
 * own Telegram bot) and a password-confirmed disable. Backup codes are
 * displayed exactly once, right after enabling — they are bcrypt-hashed
 * server-side and can never be shown again.
 */
import { useState, useTransition } from 'react'
import { Send, Smartphone } from 'lucide-react'
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
import { BackupCodes, MethodCard, type Wizard } from './twofa-settings/shared'
import { TwofaDisableCard } from './twofa-settings/disable-card'
import { TwofaStatusCard } from './twofa-settings/status-card'
import { TelegramWizard } from './twofa-settings/telegram-wizard'
import { TotpWizard } from './twofa-settings/totp-wizard'

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
      <TwofaStatusCard status={status} />

      {/* Резервные коды — показываются ровно один раз после включения. */}
      {wizard.kind === 'backup' && (
        <BackupCodes
          codes={wizard.codes}
          onDone={() => setWizard({ kind: 'none' })}
        />
      )}

      {/* Выбор метода. */}
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

      {wizard.kind === 'totp' && (
        <TotpWizard
          secret={wizard.secret}
          qrDataUrl={wizard.qrDataUrl}
          pending={pending}
          onConfirm={confirmTotp}
          onCancel={() => setWizard({ kind: 'none' })}
        />
      )}

      {wizard.kind === 'telegram' && (
        <TelegramWizard
          wizard={wizard}
          pending={pending}
          onCheckToken={checkToken}
          onDiscoverChats={discoverChats}
          onToggleChat={toggleChat}
          onAddManualChat={addManualChat}
          onSendCode={sendCode}
          onConfirm={confirmTelegram}
          onCancel={() => setWizard({ kind: 'none' })}
        />
      )}

      {enabled && wizard.kind === 'none' && (
        <TwofaDisableCard pending={pending} onDisable={disable} />
      )}
    </div>
  )
}
