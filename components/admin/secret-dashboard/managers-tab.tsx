'use client'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  ArrowUpRight,
  Ban,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Users,
} from 'lucide-react'
import {
  secretClearManagerTempPasswordAction,
  secretRevealManagerTempPasswordAction,
  secretSetManagerStatusAction,
  secretSetManagerTempPasswordAction,
  type ActionResult,
} from '@/app/actions/admin-secret'
import { EmptyState } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { Manager } from '@/lib/types'
import { copyText } from './utils'

/* ------------------------------ Managers ------------------------------ */

export function ManagersTab({
  managers,
  curators,
  pending,
  run,
}: {
  managers: Manager[]
  /** HR-curator accounts — same controls (temp password, block) as managers. */
  curators: Manager[]
  pending: boolean
  run: (a: () => Promise<ActionResult>, onDone?: () => void) => void
}) {
  const [q, setQ] = useState('')
  const [group, setGroup] = useState<'managers' | 'curators'>('managers')
  const source = group === 'managers' ? managers : curators
  const filtered = source.filter(
    (m) =>
      m.name.toLowerCase().includes(q.toLowerCase()) ||
      m.email.toLowerCase().includes(q.toLowerCase()),
  )

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
          {/* Переключатель: менеджеры продаж / менеджеры по кадрам */}
          <div
            role="tablist"
            aria-label="Тип аккаунтов"
            className="flex w-fit shrink-0 rounded-lg bg-muted/60 p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={group === 'managers'}
              onClick={() => setGroup('managers')}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                group === 'managers'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Менеджеры
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={group === 'curators'}
              onClick={() => setGroup('curators')}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                group === 'curators'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              По кадрам
            </button>
          </div>
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Поиск по имени или email"
              className="pl-8"
            />
          </div>
        </div>
        <Link
          href={group === 'managers' ? '/admin/managers' : '/admin/curators'}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'sm' }),
            'gap-1.5',
          )}
        >
          {group === 'managers'
            ? 'Управление менеджерами'
            : 'Управление кадрами'}
          <ArrowUpRight className="size-4" />
        </Link>
      </div>

      {filtered.length ? (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Имя</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead className="text-right">Действия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {m.name}
                      {m.onLunch ? (
                        <Badge
                          variant="outline"
                          className="border-warning/40 text-warning"
                        >
                          На обеде
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {m.email}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        m.status === 'active'
                          ? 'border-success/40 bg-success/10 text-success'
                          : 'border-destructive/40 bg-destructive/10 text-destructive',
                      )}
                    >
                      {m.status === 'active' ? 'Активен' : 'Заблокирован'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => copyText(m.id)}
                        className="gap-1.5"
                      >
                        <Copy className="size-3.5" />
                        ID
                      </Button>
                      <ManagerTempPassword manager={m} />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          run(() =>
                            secretSetManagerStatusAction(
                              m.id,
                              m.status === 'active' ? 'blocked' : 'active',
                            ),
                          )
                        }
                        className={cn(
                          'gap-1.5',
                          m.status === 'active' && 'text-destructive',
                        )}
                      >
                        {m.status === 'active' ? (
                          <>
                            <Ban className="size-3.5" /> Блок
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="size-3.5" /> Разблок
                          </>
                        )}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="p-6">
          <EmptyState
            icon={Users}
            title={
              group === 'managers'
                ? 'Менеджеры не найдены'
                : 'Менеджеры по кадрам не найдены'
            }
            description="Измените запрос поиска или создайте аккаунт в разделе управления."
          />
        </div>
      )}
    </Card>
  )
}

/* -------------------------- Temp password ----------------------------- */

/**
 * Per-manager temporary-password control. Opens a dialog that reveals the
 * current temp password (fetched on demand, decrypted server-side), and lets an
 * admin generate a new one, set a custom one, or clear it. This is a SEPARATE
 * credential from the manager's real password (which is a one-way bcrypt hash
 * and can never be shown) — see scripts/079_manager_temp_password.sql.
 */
function ManagerTempPassword({ manager }: { manager: Manager }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [password, setPassword] = useState<string | null>(null)
  const [setAt, setSetAt] = useState<string | null>(null)
  const [reveal, setReveal] = useState(false)
  const [custom, setCustom] = useState('')

  async function load() {
    setLoading(true)
    try {
      const res = await secretRevealManagerTempPasswordAction(manager.id)
      if (res.ok) {
        setPassword(res.password ?? null)
        setSetAt(res.setAt ?? null)
      } else {
        toast.error(res.message)
      }
    } catch {
      toast.error('Не удалось загрузить пароль')
    } finally {
      setLoading(false)
    }
  }

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      setReveal(false)
      setCustom('')
      void load()
    }
  }

  function handleSet(customValue?: string) {
    setBusy(true)
    ;(async () => {
      try {
        const res = await secretSetManagerTempPasswordAction({
          managerId: manager.id,
          password: customValue,
        })
        if (res.ok) {
          setPassword(res.password ?? null)
          setSetAt(res.setAt ?? null)
          setReveal(true)
          setCustom('')
          toast.success(res.message)
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Не удалось сохранить пароль')
      } finally {
        setBusy(false)
      }
    })()
  }

  function handleClear() {
    setBusy(true)
    ;(async () => {
      try {
        const res = await secretClearManagerTempPasswordAction(manager.id)
        if (res.ok) {
          setPassword(null)
          setSetAt(null)
          toast.success(res.message)
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Не удалось удалить пароль')
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => onOpenChange(true)}
      >
        <KeyRound className="size-3.5" />
        Пароль
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Временный пароль</DialogTitle>
          <DialogDescription>
            {manager.name} — дополнительный пароль для входа, не связанный с
            основным. Основной пароль хранится в виде необратимого хеша и не может
            быть показан.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Текущий временный пароль</Label>
            {loading ? (
              <div className="flex h-10 items-center gap-2 rounded-md border border-border px-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Загрузка…
              </div>
            ) : password ? (
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={
                    reveal ? password : '•'.repeat(Math.min(password.length, 16))
                  }
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setReveal((v) => !v)}
                  aria-label={reveal ? 'Скрыть' : 'Показать'}
                >
                  {reveal ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => copyText(password)}
                  aria-label="Скопировать"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            ) : (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
                Временный пароль не задан.
              </p>
            )}
            {setAt ? (
              <p className="text-xs text-muted-foreground">
                Установлен: {new Date(setAt).toLocaleString('ru-RU')}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`custom-${manager.id}`}>Задать свой пароль</Label>
            <div className="flex items-center gap-2">
              <Input
                id={`custom-${manager.id}`}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="Минимум 6 символов"
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                disabled={busy || custom.trim().length < 6}
                onClick={() => handleSet(custom.trim())}
              >
                Сохранить
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="outline"
            className="gap-1.5 text-destructive"
            disabled={busy || !password}
            onClick={handleClear}
          >
            <Trash2 className="size-4" />
            Удалить
          </Button>
          <Button
            type="button"
            className="gap-1.5"
            disabled={busy}
            onClick={() => handleSet(undefined)}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Сгенерировать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
