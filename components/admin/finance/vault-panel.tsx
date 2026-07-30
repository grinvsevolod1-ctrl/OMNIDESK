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
  Loader2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Star,
  Trash2,
  Upload,
  User,
  Vault,
  X,
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
  type PasswordStrength,
} from '@/lib/vault-utils'
import {
  VAULT_CATEGORIES,
  type VaultCategory,
  type VaultField,
  type VaultItem,
} from '@/lib/finance-types'
import { EmptyState } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  VAULT_CATEGORY_META,
  copyToClipboard,
  generatePassword,
} from '@/components/admin/finance/finance-utils'

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
  const display = masked ? '•'.repeat(Math.min(14, Math.max(8, value.length))) : value
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

function VaultCard({
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
          <Star
            className={cn('size-4', item.favorite && 'fill-current')}
          />
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
              copyToClipboard(
                `${item.login}\t${item.secret}`,
                'Логин и пароль',
              )
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

function StrengthMeter({
  strength,
  compact = false,
}: {
  strength: PasswordStrength
  compact?: boolean
}) {
  const barTone =
    strength.tone === 'success'
      ? 'bg-success'
      : strength.tone === 'warning'
        ? 'bg-warning'
        : strength.tone === 'destructive'
          ? 'bg-destructive'
          : 'bg-muted-foreground/40'
  const textTone =
    strength.tone === 'success'
      ? 'text-success'
      : strength.tone === 'warning'
        ? 'text-warning'
        : strength.tone === 'destructive'
          ? 'text-destructive'
          : 'text-muted-foreground'
  return (
    <div className={cn('flex items-center gap-2', compact ? 'text-xs' : 'text-sm')}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-all', barTone)}
          style={{ width: `${strength.percent}%` }}
        />
      </div>
      <span className={cn('shrink-0 font-medium', textTone)}>
        {strength.label}
      </span>
    </div>
  )
}

export function VaultDialog({
  state,
  pending,
  encryptionReady,
  onClose,
  onCreate,
  onUpdate,
}: {
  state:
    | { mode: 'create'; resourceId: string }
    | { mode: 'edit'; item: VaultItem }
    | null
  pending: boolean
  encryptionReady: boolean
  onClose: () => void
  onCreate: (resourceId: string, fd: FormData) => void
  onUpdate: (id: string, fd: FormData) => void
}) {
  const editing = state?.mode === 'edit' ? state.item : null

  const [category, setCategory] = useState<VaultCategory>('credential')
  const [title, setTitle] = useState('')
  const [login, setLogin] = useState('')
  const [secret, setSecret] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [url, setUrl] = useState('')
  const [note, setNote] = useState('')
  const [tags, setTags] = useState('')
  const [favorite, setFavorite] = useState(false)
  const [fields, setFields] = useState<VaultField[]>([])

  // This reusable dialog remains mounted; a changed vault item resets its draft.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!state) return
    if (state.mode === 'edit') {
      const it = state.item
      setCategory(it.category)
      setTitle(it.title)
      setLogin(it.login)
      setSecret(it.secret)
      setUrl(it.url)
      setNote(it.note)
      setTags(it.tags.join(', '))
      setFavorite(it.favorite)
      setFields(it.fields.map((f) => ({ ...f })))
    } else {
      setCategory('credential')
      setTitle('')
      setLogin('')
      setSecret('')
      setUrl('')
      setNote('')
      setTags('')
      setFavorite(false)
      setFields([])
    }
    setShowSecret(false)
  }, [state])
  /* eslint-enable react-hooks/set-state-in-effect */

  function updateField(index: number, patch: Partial<VaultField>) {
    setFields((prev) =>
      prev.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    )
  }

  function submit() {
    const fd = new FormData()
    fd.set('category', category)
    fd.set('title', title)
    fd.set('login', login)
    fd.set('secret', secret)
    fd.set('url', url)
    fd.set('note', note)
    fd.set('tags', tags)
    fd.set('favorite', favorite ? 'true' : 'false')
    fd.set(
      'fields',
      JSON.stringify(fields.filter((f) => f.label.trim() || f.value.trim())),
    )
    if (editing) onUpdate(editing.id, fd)
    else if (state?.mode === 'create') onCreate(state.resourceId, fd)
  }

  return (
    <Dialog open={state != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Изменить запись' : 'Новая запись в хранилище'}
            </DialogTitle>
            <DialogDescription>
              Данные привязаны к текущему ресурсу. Секреты шифруются перед
              сохранением.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="vault-category">Категория</Label>
                <Select
                  value={category}
                  onValueChange={(v) => setCategory(v as VaultCategory)}
                >
                  <SelectTrigger id="vault-category" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VAULT_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {VAULT_CATEGORY_META[c].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="vault-title">Название</Label>
                <Input
                  id="vault-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Например: cPanel хостинга"
                  autoFocus
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="vault-login">Логин / e-mail / ник / номер</Label>
              <Input
                id="vault-login"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                placeholder="admin@site.com"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="vault-secret">Пароль / токен / ключ</Label>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Input
                    id="vault-secret"
                    type={showSecret ? 'text' : 'password'}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder="••••••••"
                    className="pr-9 font-mono"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                    aria-label={showSecret ? 'Скрыть' : 'Показать'}
                  >
                    {showSecret ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    setSecret(generatePassword())
                    setShowSecret(true)
                  }}
                  aria-label="Сгенерировать пароль"
                  title="Сгенерировать надёжный пароль"
                >
                  <RefreshCw className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  disabled={!secret}
                  onClick={() => copyToClipboard(secret, 'Секрет')}
                  aria-label="Скопировать"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
              {secret ? <StrengthMeter strength={scorePassword(secret)} /> : null}
              {!encryptionReady ? (
                <p className="text-xs text-warning">
                  Секрет не сохранится, пока не задан ENCRYPTION_KEY.
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="vault-url">Ссылка / хост</Label>
              <Input
                id="vault-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://panel.site.com  или  185.12.3.4:22"
              />
            </div>

            {/* Custom fields */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Дополнительные поля</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() =>
                    setFields((prev) => [
                      ...prev,
                      { label: '', value: '', secret: false },
                    ])
                  }
                >
                  <Plus className="size-3.5" /> Поле
                </Button>
              </div>
              {fields.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  IP, порт, PIN, ключ восстановления, номер карты, seed-фраза —
                  что угодно. Отметьте «секрет», чтобы значение скрывалось.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {fields.map((f, i) => (
                    <div
                      key={i}
                      className="flex flex-col gap-2 rounded-md border border-border p-2 sm:flex-row sm:items-center"
                    >
                      <Input
                        value={f.label}
                        onChange={(e) =>
                          updateField(i, { label: e.target.value })
                        }
                        placeholder="Название"
                        className="sm:w-1/3"
                      />
                      <Input
                        value={f.value}
                        onChange={(e) =>
                          updateField(i, { value: e.target.value })
                        }
                        placeholder="Значение"
                        type={f.secret ? 'password' : 'text'}
                        className="flex-1 font-mono"
                      />
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Switch
                          checked={f.secret}
                          onCheckedChange={(v) =>
                            updateField(i, { secret: Boolean(v) })
                          }
                        />
                        секрет
                      </label>
                      <button
                        type="button"
                        onClick={() =>
                          setFields((prev) => prev.filter((_, idx) => idx !== i))
                        }
                        className="self-end rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive sm:self-auto"
                        aria-label="Удалить поле"
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="vault-tags">Теги</Label>
              <Input
                id="vault-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="через запятую: прод, важное, VPS"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="vault-note">Заметка</Label>
              <Textarea
                id="vault-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Детали, комментарии, контекст…"
              />
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Switch checked={favorite} onCheckedChange={(v) => setFavorite(Boolean(v))} />
              Закрепить вверху
            </label>
          </div>

          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline">
                  Отмена
                </Button>
              }
            />
            <Button type="submit" disabled={pending}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : editing ? (
                'Сохранить'
              ) : (
                'Добавить'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
