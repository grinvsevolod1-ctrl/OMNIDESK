'use client'

/**
 * Vault create/edit dialog + password strength meter, extracted from
 * vault-panel.tsx. Fully props-driven like the rest of the vault module.
 */

import { useEffect, useState } from 'react'
import { Copy, Eye, EyeOff, Loader2, Plus, RefreshCw, X } from 'lucide-react'
import { scorePassword, type PasswordStrength } from '@/lib/vault-utils'
import {
  VAULT_CATEGORIES,
  type VaultCategory,
  type VaultField,
  type VaultItem,
} from '@/lib/finance-types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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

export function StrengthMeter({
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
