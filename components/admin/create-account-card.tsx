'use client'

/**
 * Карточка «Подключить аккаунт» — презентационный контейнер. Вся логика
 * (форма, отправка, многошаговый Telegram-логин с поллингом) — в
 * create-account/use-create-account.ts; модалка логина — в
 * create-account/telegram-login-dialog.tsx.
 */

import Link from 'next/link'
import { Loader2, Plus, QrCode, Smartphone } from 'lucide-react'
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
import type { Manager, Proxy } from '@/lib/types'
import {
  TYPE_ICON,
  proxyLabelText,
  type CreatableType,
} from '@/components/admin/account-shared'
import { useCreateAccount } from './create-account/use-create-account'
import { TelegramLoginDialog } from './create-account/telegram-login-dialog'

const TYPES: { value: CreatableType; label: string }[] = [
  { value: 'telegram', label: 'Telegram' },
  { value: 'vk', label: 'VK' },
  { value: 'max', label: 'MAX' },
]

export function CreateAccountCard({
  proxies,
  managers,
  proxyUsage,
  workerOnline,
  only,
}: {
  proxies: Proxy[]
  managers: Manager[]
  proxyUsage: Record<string, string[]>
  workerOnline: boolean
  only?: CreatableType
}) {
  const {
    type,
    setType,
    managerId,
    setManagerId,
    proxyId,
    setProxyId,
    name,
    setName,
    phone,
    setPhone,
    token,
    setToken,
    pending,
    eligibleProxies,
    tgMethod,
    setTgMethod,
    tgChannelId,
    tgStep,
    tgCode,
    setTgCode,
    tgPassword,
    setTgPassword,
    tgQrImage,
    tgError,
    submitCreate,
    submitCode,
    submitPassword,
    retryLogin,
    resetForm,
  } = useCreateAccount({ proxies, proxyUsage, workerOnline, only })

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center gap-2">
        <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-muted/40">
          <Plus className="size-4" />
        </div>
        <div>
          <h2 className="text-sm font-semibold">Подключить аккаунт</h2>
          <p className="text-xs text-muted-foreground">
            Создание аккаунтов доступно только администратору. Прокси
            необязателен — без него подключение идёт напрямую.
          </p>
        </div>
      </div>

      {/* Type selector — hidden when the card is scoped to one source. */}
      {!only ? (
        <div className="mb-4 grid grid-cols-3 gap-2">
          {TYPES.map((t) => {
            const Icon = TYPE_ICON[t.value]
            const active = type === t.value
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => {
                  setType(t.value)
                  setProxyId('')
                }}
                disabled={pending || Boolean(tgChannelId)}
                className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? 'border-foreground bg-secondary text-secondary-foreground'
                    : 'border-border text-muted-foreground hover:bg-muted/50'
                }`}
              >
                <Icon className="size-4" />
                {t.label}
              </button>
            )
          })}
        </div>
      ) : null}

      {!only ? (
        <p className="mb-4 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          WhatsApp подключается на странице{' '}
          <Link href="/admin/whatsapp" className="font-medium text-foreground underline">
            WhatsApp
          </Link>
          , после чего назначьте номеру прокси в таблице ниже.
        </p>
      ) : null}

      {/* Common fields. Wrapped in a <form> so browsers can associate the
          password inputs (MAX/VK token, TG 2FA) with a form for autofill and
          to silence "Password field is not contained in a form". */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!pending && !(type === 'telegram' && !workerOnline)) {
            void submitCreate()
          }
        }}
      >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label>Менеджер-владелец</Label>
          <Select
            value={managerId}
            onValueChange={(v) => setManagerId(v ?? '')}
          >
            <SelectTrigger>
              <SelectValue placeholder="Выберите менеджера" />
            </SelectTrigger>
            <SelectContent>
              {managers.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Прокси (необязательно)</Label>
          <Select
            value={proxyId || 'none'}
            onValueChange={(v) => setProxyId(v === 'none' ? '' : (v ?? ''))}
          >
            <SelectTrigger className="min-w-0">
              <SelectValue placeholder="Без прокси — прямое подключение">
                {(value: string | null) =>
                  !value || value === 'none'
                    ? 'Без прокси — прямое подключение'
                    : (eligibleProxies.find((p) => p.id === value)
                        ? proxyLabelText(
                            eligibleProxies.find((p) => p.id === value)!,
                          )
                        : 'Прокси выбран')
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                Без прокси — прямое подключение
              </SelectItem>
              {eligibleProxies.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {proxyLabelText(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Прокси не обязателен. Если аккаунт не подключается через прокси
            (например, прокси не пропускает Telegram), выберите «Без прокси» —
            подключение пойдёт напрямую.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Название {type === 'telegram' ? '' : '(необязательно)'}</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например, «Продажи»"
            disabled={Boolean(tgChannelId)}
          />
        </div>

        {type === 'telegram' ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Способ входа</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setTgMethod('qr')}
                  disabled={pending || Boolean(tgChannelId)}
                  className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                    tgMethod === 'qr'
                      ? 'border-foreground bg-secondary text-secondary-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted/50'
                  }`}
                >
                  <QrCode className="size-4" />
                  По QR-коду
                </button>
                <button
                  type="button"
                  onClick={() => setTgMethod('phone')}
                  disabled={pending || Boolean(tgChannelId)}
                  className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                    tgMethod === 'phone'
                      ? 'border-foreground bg-secondary text-secondary-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted/50'
                  }`}
                >
                  <Smartphone className="size-4" />
                  По номеру
                </button>
              </div>
            </div>
            {tgMethod === 'phone' ? (
              <div className="flex flex-col gap-1.5">
                <Label>Номер телефона</Label>
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+14155550132"
                  disabled={Boolean(tgChannelId)}
                />
              </div>
            ) : null}
            {!workerOnline ? (
              <p className="text-xs text-warning">
                Воркер не в сети — вход в Telegram сейчас недоступен. Запустите
                процесс воркера на VPS, чтобы продолжить.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {tgMethod === 'qr'
                  ? 'Появится QR-код: отсканируйте его с телефона владельца аккаунта — Telegram → Настройки → Устройства → Подключить устройство.'
                  : 'После нажатия «Подключить» откроется окно для ввода кода из Telegram.'}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label>
              {type === 'vk' ? 'Токен сообщества VK' : 'Токен бота MAX'}
            </Label>
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                type === 'vk'
                  ? 'vk1.a.xxxxxxxx (scope: messages + manage)'
                  : 'Токен из @MasterBot'
              }
              type="password"
            />
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button
          type="submit"
          disabled={pending || (type === 'telegram' && !workerOnline)}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          Подключить
        </Button>
      </div>
      </form>

      {/*
        Telegram login modal. It opens automatically as soon as the connect flow
        starts (tgChannelId is set) so the code / 2FA-password entry is
        impossible to miss.
      */}
      <TelegramLoginDialog
        open={Boolean(tgChannelId)}
        method={tgMethod}
        phone={phone}
        step={tgStep}
        code={tgCode}
        setCode={setTgCode}
        password={tgPassword}
        setPassword={setTgPassword}
        qrImage={tgQrImage}
        error={tgError}
        pending={pending}
        onSubmitCode={submitCode}
        onSubmitPassword={submitPassword}
        onRetry={retryLogin}
        onCancel={resetForm}
      />
    </Card>
  )
}
