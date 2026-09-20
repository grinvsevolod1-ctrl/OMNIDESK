'use client'

import { useEffect, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Loader2, Plus, Trash2, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  createApiKeyAction,
  deleteApiKeyAction,
  listApiKeysAction,
  setApiKeyStatusAction,
} from '@/app/actions/admin-secret/outreach-config'
import type { OutreachApiKey } from '@/lib/data/outreach-api-keys'
import { cn } from '@/lib/utils'

/**
 * Пул Telegram API-ключей: несколько пар api_id/api_hash, чтобы боевые аккаунты
 * не висели на одном app_id (анти-бан). Видна загрузка каждого ключа.
 */
export function ApiKeysPanel() {
  const [keys, setKeys] = useState<OutreachApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, startTransition] = useTransition()

  const [label, setLabel] = useState('')
  const [apiId, setApiId] = useState('')
  const [apiHash, setApiHash] = useState('')
  const [maxAccounts, setMaxAccounts] = useState('20')

  useEffect(() => {
    let cancelled = false
    listApiKeysAction()
      .then((rows) => {
        if (!cancelled) setKeys(rows)
      })
      .catch(() => toast.error('Не удалось загрузить ключи'))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  function add() {
    const id = Number(apiId.trim())
    if (!id || !apiHash.trim()) {
      toast.error('Укажите api_id и api_hash')
      return
    }
    startTransition(async () => {
      try {
        const rows = await createApiKeyAction({
          label: label.trim(),
          apiId: id,
          apiHash: apiHash.trim(),
          maxAccounts: Number(maxAccounts) || 20,
        })
        setKeys(rows)
        setLabel('')
        setApiId('')
        setApiHash('')
        setMaxAccounts('20')
        toast.success('Ключ добавлен')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Ошибка')
      }
    })
  }

  function toggle(k: OutreachApiKey) {
    startTransition(async () => {
      try {
        const rows = await setApiKeyStatusAction(
          k.id,
          k.status === 'active' ? 'disabled' : 'active',
        )
        setKeys(rows)
      } catch {
        toast.error('Ошибка')
      }
    })
  }

  function remove(k: OutreachApiKey) {
    if (k.accountsCount > 0) {
      toast.error('Сначала отвяжите аккаунты от ключа')
      return
    }
    startTransition(async () => {
      try {
        const rows = await deleteApiKeyAction(k.id)
        setKeys(rows)
        toast.success('Ключ удалён')
      } catch {
        toast.error('Ошибка')
      }
    })
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-card/40 p-4">
        <p className="mb-1 text-sm font-semibold">Зачем пул ключей</p>
        <p className="text-sm text-muted-foreground text-pretty">
          Telegram привязывает «приложение» к паре api_id/api_hash. Десятки
          аккаунтов на одном ключе — явный признак фермы. Каждый новый аккаунт
          вешается на наименее загруженный активный ключ автоматически.
        </p>
      </div>

      {/* Форма добавления */}
      <div className="rounded-xl border border-border bg-card/40 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="ok-label">Метка</Label>
            <Input
              id="ok-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="app #1"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ok-id">api_id</Label>
            <Input
              id="ok-id"
              value={apiId}
              onChange={(e) => setApiId(e.target.value)}
              placeholder="1234567"
              inputMode="numeric"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ok-hash">api_hash</Label>
            <Input
              id="ok-hash"
              value={apiHash}
              onChange={(e) => setApiHash(e.target.value)}
              placeholder="abcdef…"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ok-max">Макс. аккаунтов</Label>
            <Input
              id="ok-max"
              value={maxAccounts}
              onChange={(e) => setMaxAccounts(e.target.value)}
              inputMode="numeric"
            />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <Button onClick={add} disabled={pending} className="gap-1.5">
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Добавить ключ
          </Button>
        </div>
      </div>

      {/* Список ключей */}
      {loading ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : keys.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Пока нет ни одного ключа.
        </p>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => {
            const full = k.accountsCount >= k.maxAccounts
            return (
              <div
                key={k.id}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card/40 p-4"
              >
                <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-muted/40">
                  <KeyRound className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {k.label || `api_id ${k.apiId}`}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    id {k.apiId} · hash {k.apiHashMasked}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className={cn(
                    full && 'border-destructive/40 text-destructive',
                  )}
                >
                  {k.accountsCount}/{k.maxAccounts} акк.
                </Badge>
                <Badge
                  variant={k.status === 'active' ? 'default' : 'secondary'}
                >
                  {k.status === 'active' ? 'активен' : 'выключен'}
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => toggle(k)}
                  disabled={pending}
                >
                  {k.status === 'active' ? 'Выключить' : 'Включить'}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(k)}
                  disabled={pending}
                  title="Удалить ключ"
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
