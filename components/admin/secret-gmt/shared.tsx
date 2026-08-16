'use client'

/**
 * Общие хелперы и мелкие презентационные компоненты вкладки «API TG»
 * (Get My TG). Вынесены из secret-gmt-tab.tsx, чтобы секции (Каталог,
 * Покупки, Опт) переиспользовали форматтеры, бейджи статусов и память
 * bulk-ID без дублирования. Часть god-панели — инварианты AGENTS.md §4.
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { Check, Copy, Loader2 } from 'lucide-react'
import type {
  GmtMoney,
  GmtPurchase,
  GmtPurchaseStatus,
} from '@/app/actions/admin-secret'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

/* ------------------------------- Форматтеры ----------------------------- */

export function fmtMoney(m: GmtMoney | null | undefined): string {
  if (!m) return '—'
  return `${m.amount} ${m.currency_code}`
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** `+7999…` из любого формата — ключ для сверки с импортированными номерами. */
export function normalizePhoneKey(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '')
  return digits ? `+${digits}` : ''
}

/** Сколько минут осталось до права на возврат (PENDING > 20 мин, из доков). */
export function refundEtaMinutes(p: GmtPurchase): number {
  const elapsed = Date.now() - new Date(p.created_at).getTime()
  return Math.max(0, Math.ceil(20 - elapsed / 60_000))
}

/* ------------------------------- Статусы -------------------------------- */

const STATUS_LABEL: Record<GmtPurchaseStatus, string> = {
  PENDING: 'Ожидает код',
  SUCCESS: 'Готов',
  ERROR: 'Ошибка',
  REFUND: 'Возврат',
}

const STATUS_CLASS: Record<GmtPurchaseStatus, string> = {
  PENDING: 'border-warning/40 text-warning',
  SUCCESS: 'border-success/40 text-success',
  ERROR: 'border-destructive/40 text-destructive',
  REFUND: 'border-border text-muted-foreground',
}

export const TAG_META: Record<string, { label: string; cls: string }> = {
  HIGH_QUALITY: { label: 'Топ качество', cls: 'border-primary/40 text-primary' },
  HIGH_DEMAND: { label: 'Высокий спрос', cls: 'border-warning/40 text-warning' },
}

export function StatusBadge({ status }: { status: GmtPurchaseStatus }) {
  return (
    <Badge variant="outline" className={STATUS_CLASS[status]}>
      {status === 'PENDING' ? (
        <Loader2 className="mr-1 size-3 animate-spin" aria-hidden />
      ) : null}
      {STATUS_LABEL[status]}
    </Badge>
  )
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6 shrink-0"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          toast.error('Не удалось скопировать')
        }
      }}
      aria-label={`Скопировать ${label}`}
    >
      {copied ? (
        <Check className="size-3.5 text-success" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </Button>
  )
}

/* --------------------- Память bulk-ID (localStorage) -------------------- */

/**
 * У API нет эндпоинта «список bulk-закупок» — только статус по ID. Панель
 * помнит созданные ID в localStorage браузера (НЕ в БД — инвариант вкладки),
 * плюс любой ID можно добавить вручную в секции «Опт».
 */
const BULK_IDS_KEY = 'god-gmt-bulk-ids'

export function readBulkIds(): number[] {
  try {
    const raw = localStorage.getItem(BULK_IDS_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr)
      ? arr.filter((n): n is number => Number.isInteger(n) && n > 0)
      : []
  } catch {
    return []
  }
}

export function rememberBulkId(id: number) {
  try {
    const ids = readBulkIds()
    if (!ids.includes(id)) {
      // Свежие сверху, максимум 50 — старые архивы живут у сервиса.
      localStorage.setItem(
        BULK_IDS_KEY,
        JSON.stringify([id, ...ids].slice(0, 50)),
      )
    }
  } catch {
    /* localStorage недоступен — не критично */
  }
}
