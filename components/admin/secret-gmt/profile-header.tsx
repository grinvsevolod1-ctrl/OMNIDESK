'use client'

/**
 * Шапка вкладки «API TG»: профиль Get My TG (баланс, скидка, статистика,
 * рефералы), health-индикатор и управление ключом API (форма + диалог смены/
 * удаления, карточка первичной настройки). Часть god-панели — AGENTS.md §4.
 */

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  BadgePercent,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Package,
  RefreshCw,
  RotateCcw,
  ShoppingCart,
  Users,
  Wallet,
} from 'lucide-react'
import {
  secretGmtClearKeyAction,
  secretGmtSetKeyAction,
  type GmtProfile,
} from '@/app/actions/admin-secret'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { fmtMoney } from './shared'

export function ProfileHeader({
  profile,
  health,
  keySource,
  keyMasked,
  onRefresh,
  onKeyChanged,
}: {
  profile: GmtProfile | null
  health: 'ok' | 'degraded' | 'unreachable'
  keySource: 'db' | 'env' | null
  keyMasked: string | null
  onRefresh: () => void
  onKeyChanged: () => void
}) {
  const [keyDialogOpen, setKeyDialogOpen] = useState(false)
  const healthMeta =
    health === 'ok'
      ? { cls: 'bg-success', label: 'API на связи' }
      : health === 'degraded'
        ? { cls: 'bg-warning', label: 'API деградирован' }
        : { cls: 'bg-destructive', label: 'API недоступен' }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md border border-border bg-muted/40">
            <ShoppingCart className="size-4 text-muted-foreground" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-medium">Get My TG</h2>
              <span
                className={cn('inline-block size-2 rounded-full', healthMeta.cls)}
                title={healthMeta.label}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {profile?.telegram_username
                ? `@${profile.telegram_username}`
                : 'Магазин Telegram-аккаунтов'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Пополнение — только через официального бота: у API Get My TG нет
              платёжных эндпоинтов (см. sdk-reference), баланс живёт в боте. */}
          <Button
            size="sm"
            className="h-8 gap-1.5"
            onClick={() =>
              window.open(
                'https://t.me/GetMyTGrobot',
                '_blank',
                'noopener,noreferrer',
              )
            }
          >
            <Wallet className="size-3.5" />
            Пополнить
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 bg-transparent"
            onClick={() => setKeyDialogOpen(true)}
          >
            <KeyRound className="size-3.5" />
            Ключ
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 bg-transparent"
            onClick={onRefresh}
          >
            <RefreshCw className="size-3.5" />
            Обновить
          </Button>
        </div>
      </div>

      <GmtKeyDialog
        open={keyDialogOpen}
        onOpenChange={setKeyDialogOpen}
        keySource={keySource}
        keyMasked={keyMasked}
        onKeyChanged={onKeyChanged}
      />

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          icon={Wallet}
          label="Баланс"
          value={profile ? fmtMoney(profile.balance) : null}
          accent
        />
        <StatTile
          icon={BadgePercent}
          label={`Скидка${profile?.discount && profile.discount.level !== 'none' ? ` · ${profile.discount.level}` : ''}`}
          value={profile ? `${profile.discount?.percent ?? 0}%` : null}
        />
        <StatTile
          icon={Package}
          label="Всего покупок"
          value={profile ? String(profile.statistics?.total_purchases ?? 0) : null}
        />
        <StatTile
          icon={Users}
          label={`Рефералы · ${profile?.referral?.referrals_count ?? 0}`}
          value={profile ? fmtMoney(profile.referral?.balance) : null}
        />
      </div>
    </Card>
  )
}

function StatTile({
  icon: Icon,
  label,
  value,
  accent = false,
}: {
  icon: typeof Wallet
  label: string
  value: string | null
  accent?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-lg border p-3',
        accent ? 'border-primary/30 bg-primary/5' : 'border-border bg-muted/20',
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </div>
      {value === null ? (
        <Skeleton className="h-6 w-20" />
      ) : (
        <span
          className={cn(
            'text-lg font-semibold tabular-nums',
            accent && 'text-primary',
          )}
        >
          {value}
        </span>
      )}
    </div>
  )
}

/* ----------------------------- Ключ API --------------------------------- */

/**
 * Форма ввода ключа: используется и в карточке первичной настройки, и в
 * диалоге смены ключа. Ключ проверяется сервером живым запросом к API ДО
 * сохранения (secretGmtSetKeyAction) — опечатка не затирает рабочий ключ.
 */
function GmtKeyForm({
  onSaved,
  autoFocus,
}: {
  onSaved: () => void
  autoFocus?: boolean
}) {
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [pending, startTransition] = useTransition()

  const submit = () => {
    const trimmed = key.trim()
    if (!trimmed) return
    startTransition(async () => {
      const res = await secretGmtSetKeyAction(trimmed)
      if (res.ok) {
        toast.success(res.message)
        setKey('')
        onSaved()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <Input
          type={show ? 'text' : 'password'}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            )
              submit()
          }}
          placeholder="Ключ API из бота Get My TG"
          autoFocus={autoFocus}
          className="pr-9 font-mono text-sm"
          aria-label="Ключ API Get My TG"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label={show ? 'Скрыть ключ' : 'Показать ключ'}
        >
          {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      <Button onClick={submit} disabled={pending || !key.trim()} className="gap-1.5">
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Check className="size-3.5" />
        )}
        Сохранить
      </Button>
    </div>
  )
}

/** Карточка первичной настройки — показывается, пока ключ не назначен. */
export function GmtKeySetupCard({ onSaved }: { onSaved: () => void }) {
  return (
    <Card className="p-6">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="flex w-full max-w-xl flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="font-medium">Подключение Get My TG</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Вставьте ключ API — его выдаёт официальный Telegram-бот сервиса.
              Ключ проверяется и сохраняется прямо в панели, перезапуск не
              нужен.
            </p>
          </div>
          <GmtKeyForm onSaved={onSaved} autoFocus />
        </div>
      </div>
    </Card>
  )
}

/** Диалог управления ключом: смена и удаление из панели. */
function GmtKeyDialog({
  open,
  onOpenChange,
  keySource,
  keyMasked,
  onKeyChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  keySource: 'db' | 'env' | null
  keyMasked: string | null
  onKeyChanged: () => void
}) {
  const [pending, startTransition] = useTransition()

  const removeKey = () => {
    startTransition(async () => {
      const res = await secretGmtClearKeyAction()
      if (res.ok) {
        toast.success(res.message)
        onKeyChanged()
        onOpenChange(false)
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ключ API Get My TG</DialogTitle>
          <DialogDescription>
            {keySource === 'db'
              ? `Действующий ключ ${keyMasked ?? ''} назначен из панели.`
              : keySource === 'env'
                ? `Действующий ключ ${keyMasked ?? ''} взят из env GMT_API_KEY. Ключ, сохранённый здесь, будет иметь приоритет.`
                : 'Ключ не настроен.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <GmtKeyForm
            onSaved={() => {
              onKeyChanged()
              onOpenChange(false)
            }}
          />
          {keySource === 'db' ? (
            <Button
              variant="outline"
              onClick={removeKey}
              disabled={pending}
              className="w-fit gap-1.5 bg-transparent text-destructive hover:text-destructive"
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
              Удалить ключ из панели
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
