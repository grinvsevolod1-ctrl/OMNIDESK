'use client'

/**
 * Одна карточка записи хранилища: маскируемые строки (VaultRow) с копированием
 * и авто-скрытием секретов, индикаторы слабых/повторяющихся паролей, теги и
 * действия. Вынесена из vault-panel.tsx — панель остаётся сеткой + тулбаром.
 */

import type React from 'react'
import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ClipboardCopy,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Globe,
  KeyRound,
  Lock,
  Pencil,
  ShieldAlert,
  Star,
  Trash2,
  User,
} from 'lucide-react'
import { scorePassword } from '@/lib/vault-utils'
import type { VaultItem } from '@/lib/finance-types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import {
  VAULT_CATEGORY_META,
  copyToClipboard,
} from '@/components/admin/finance/finance-utils'
import { StrengthMeter } from './vault-dialog'

/** One masked/copyable row inside a vault card. */
function VaultRow({
  icon: Icon,
  label,
  value,
  secret = false,
  href,
}: {
  icon: typeof KeyRound
  label: string
  value: string
  secret?: boolean
  href?: string
}) {
  const [show, setShow] = useState(false)

  // Auto-hide a revealed secret after 20s so it never lingers on screen.
  useEffect(() => {
    if (!show || !secret) return
    const t = setTimeout(() => setShow(false), 20000)
    return () => clearTimeout(t)
  }, [show, secret])

  if (!value) return null
  const masked = secret && !show
  const display = masked
    ? '•'.repeat(Math.min(14, Math.max(8, value.length)))
    : value
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        {href && !masked ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate font-mono text-sm text-primary hover:underline"
          >
            {display}
          </a>
        ) : (
          <p className="truncate font-mono text-sm">{display}</p>
        )}
      </div>
      {secret ? (
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={show ? 'Скрыть' : 'Показать'}
        >
          {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      ) : null}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Открыть ссылку"
        >
          <ExternalLink className="size-3.5" />
        </a>
      ) : null}
      <button
        type="button"
        onClick={() => copyToClipboard(value, label)}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={`Скопировать: ${label}`}
      >
        <Copy className="size-3.5" />
      </button>
    </div>
  )
}

export function VaultCard({
  item,
  pending,
  reused,
  onEdit,
  onToggleFavorite,
  onDelete,
}: {
  item: VaultItem
  pending: boolean
  reused?: boolean
  onEdit: () => void
  onToggleFavorite: () => void
  onDelete: () => void
}) {
  const meta = VAULT_CATEGORY_META[item.category]
  const Icon = meta.icon
  const url = item.url
    ? /^https?:\/\//i.test(item.url)
      ? item.url
      : `https://${item.url}`
    : undefined
  const strength = item.secret ? scorePassword(item.secret) : null
  const weak = strength != null && strength.score <= 1
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg',
            meta.tint,
          )}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h4 className="truncate font-medium leading-tight">{item.title}</h4>
            {weak ? (
              <span title="Слабый пароль">
                <ShieldAlert className="size-3.5 shrink-0 text-warning" />
              </span>
            ) : null}
            {reused ? (
              <span title="Пароль повторяется в другой записи">
                <AlertTriangle className="size-3.5 shrink-0 text-warning" />
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{meta.label}</p>
        </div>
        <button
          type="button"
          onClick={onToggleFavorite}
          disabled={pending}
          className={cn(
            'rounded p-1 transition-colors hover:bg-muted disabled:opacity-50',
            item.favorite
              ? 'text-warning'
              : 'text-muted-foreground hover:text-foreground',
          )}
          aria-label={item.favorite ? 'Открепить' : 'Закрепить'}
        >
          <Star className={cn('size-4', item.favorite && 'fill-current')} />
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <VaultRow icon={User} label="Логин" value={item.login} />
        <VaultRow icon={Lock} label="Секрет" value={item.secret} secret />
        <VaultRow icon={Globe} label="Ссылка / хост" value={item.url} href={url} />
        {item.fields.map((f, i) => (
          <VaultRow
            key={`${f.label}-${i}`}
            icon={f.secret ? KeyRound : FileText}
            label={f.label || 'Поле'}
            value={f.value}
            secret={f.secret}
          />
        ))}
      </div>

      {strength != null ? <StrengthMeter strength={strength} compact /> : null}

      {item.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {item.tags.map((t) => (
            <Badge key={t} variant="outline" className="text-xs font-normal">
              {t}
            </Badge>
          ))}
        </div>
      ) : null}

      {item.note ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
          {item.note}
        </p>
      ) : null}

      <div className="mt-auto flex items-center gap-1 border-t border-border/60 pt-2">
        {item.login && item.secret ? (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() =>
              copyToClipboard(`${item.login}\t${item.secret}`, 'Логин и пароль')
            }
            title="Скопировать логин и пароль (через таб)"
          >
            <ClipboardCopy className="size-3.5" /> Логин+пароль
          </Button>
        ) : null}
        <div className="flex-1" />
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={onEdit}>
          <Pencil className="size-3.5" /> Изменить
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-destructive hover:text-destructive"
          onClick={onDelete}
          aria-label="Удалить"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </Card>
  )
}
