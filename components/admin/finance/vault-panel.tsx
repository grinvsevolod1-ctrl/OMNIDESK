'use client'

/**
 * Vault sub-tab of the finance admin area, extracted from the finance-admin.tsx
 * monolith. Fully props-driven: every server action is passed in by the parent
 * (onAdd/onEdit/onDelete/onImport/onCreate/onUpdate), so this module stays a
 * pure presentation layer with no data fetching of its own. VaultPanel renders
 * the grid + toolbar; VaultDialog is the shared create/edit form.
 */

import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ClipboardCopy,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Globe,
  KeyRound,
  Lock,
  Pencil,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  Star,
  Trash2,
  Upload,
  User,
  Vault,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  downloadText,
  findReusedSecrets,
  parseVaultFile,
  scorePassword,
  toCSV,
  toJSON,
  type ParsedVaultRow,
} from '@/lib/vault-utils'
import {
  VAULT_CATEGORIES,
  type VaultCategory,
  type VaultItem,
} from '@/lib/finance-types'
import { EmptyState } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  VAULT_CATEGORY_META,
  copyToClipboard,
} from '@/components/admin/finance/finance-utils'
import { VaultCard } from './vault-card'

export function VaultPanel({
  items,
  encryptionReady,
  pending,
  resourceName,
  onAdd,
  onEdit,
  onToggleFavorite,
  onDelete,
  onImport,
}: {
  items: VaultItem[]
  encryptionReady: boolean
  pending: boolean
  resourceName: string
  onAdd: () => void
  onEdit: (item: VaultItem) => void
  onToggleFavorite: (item: VaultItem) => void
  onDelete: (item: VaultItem) => void
  onImport: (rows: ParsedVaultRow[]) => void
}) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<'all' | VaultCategory>('all')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const reusedSecrets = useMemo(() => findReusedSecrets(items), [items])

  const countByCategory = useMemo(() => {
    const map = new Map<VaultCategory, number>()
    for (const it of items) map.set(it.category, (map.get(it.category) ?? 0) + 1)
    return map
  }, [items])

  function slug(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9а-я]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'vault'
    )
  }

  async function handleFile(file: File) {
    try {
      const text = await file.text()
      const rows = parseVaultFile(file.name, text)
      if (rows.length === 0) {
        toast.error('В файле не найдено записей.')
        return
      }
      onImport(rows)
    } catch {
      toast.error('Не удалось прочитать файл. Ожидается CSV или JSON.')
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((it) => {
      if (category !== 'all' && it.category !== category) return false
      if (!q) return true
      const hay = [
        it.title,
        it.login,
        it.url,
        it.note,
        VAULT_CATEGORY_META[it.category].label,
        ...it.tags,
        ...it.fields.map((f) => f.label),
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [items, search, category])

  const activeCategories = VAULT_CATEGORIES.filter(
    (c) => (countByCategory.get(c) ?? 0) > 0,
  )

  return (
    <div className="flex flex-col gap-4">
      {/* Security banner */}
      {encryptionReady ? (
        <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          <ShieldCheck className="size-4 shrink-0" />
          <span className="text-pretty">
            Пароли и секреты шифруются AES-256-GCM — в базе хранится только
            шифртекст.
          </span>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span className="text-pretty">
            {'Ключ шифрования не задан. Задайте переменную '}
            <code className="rounded bg-warning/20 px-1 font-mono text-[13px]">
              ENCRYPTION_KEY
            </code>
            {' (openssl rand -hex 32), чтобы сохранять пароли и секреты.'}
          </span>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по названию, логину, тегам…"
            className="pl-9"
            aria-label="Поиск по хранилищу"
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.json,text/csv,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleFile(file)
              e.target.value = ''
            }}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  disabled={items.length === 0}
                  aria-label="Экспорт хранилища"
                  title="Экспорт"
                >
                  <Download className="size-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() =>
                  downloadText(
                    `${slug(resourceName)}-vault.json`,
                    toJSON(items),
                    'application/json',
                  )
                }
              >
                Экспорт в JSON
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  downloadText(
                    `${slug(resourceName)}-vault.csv`,
                    toCSV(items),
                    'text/csv',
                  )
                }
              >
                Экспорт в CSV
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            disabled={pending}
            aria-label="Импорт в хранилище"
            title="Импорт из CSV / JSON"
          >
            <Upload className="size-4" />
          </Button>
          <Button className="gap-1.5" onClick={onAdd}>
            <Plus className="size-4" /> Добавить запись
          </Button>
        </div>
      </div>

      {/* Category filter chips */}
      {activeCategories.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <VaultChip
            active={category === 'all'}
            label="Все"
            count={items.length}
            onClick={() => setCategory('all')}
          />
          {activeCategories.map((c) => {
            const meta = VAULT_CATEGORY_META[c]
            const Icon = meta.icon
            return (
              <VaultChip
                key={c}
                active={category === c}
                label={meta.label}
                count={countByCategory.get(c) ?? 0}
                icon={<Icon className="size-3.5" />}
                onClick={() => setCategory(c)}
              />
            )
          })}
        </div>
      ) : null}

      {/* Content */}
      {items.length === 0 ? (
        <EmptyState
          icon={Vault}
          title="Хранилище пустое"
          description="Соберите здесь все данные проекта: учётные записи, сервера, аккаунты, ники, счета и оплаты. Секреты шифруются."
          action={
            <Button className="gap-1.5" onClick={onAdd}>
              <Plus className="size-4" /> Добавить первую запись
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          Ничего не найдено. Измените запрос или категорию.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((item) => (
            <VaultCard
              key={item.id}
              item={item}
              pending={pending}
              reused={!!item.secret && reusedSecrets.has(item.secret)}
              onEdit={() => onEdit(item)}
              onToggleFavorite={() => onToggleFavorite(item)}
              onDelete={() => onDelete(item)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function VaultChip({
  active,
  label,
  count,
  icon,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  icon?: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-card text-foreground hover:bg-muted',
      )}
    >
      {icon}
      <span>{label}</span>
      <span
        className={cn(
          'rounded-full px-1.5 text-xs tabular-nums',
          active ? 'bg-primary-foreground/20' : 'bg-muted text-muted-foreground',
        )}
      >
        {count}
      </span>
    </button>
  )
}

/*
 * VaultCard/VaultRow moved to vault-card.tsx; VaultDialog and StrengthMeter
 * moved to vault-dialog.tsx. Re-exported so existing imports keep working.
 */
export { VaultDialog } from './vault-dialog'
