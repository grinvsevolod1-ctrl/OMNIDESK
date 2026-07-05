'use client'

import { useState, useTransition } from 'react'
import {
  Globe,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  checkManagerProxyAction,
  createManagerProxyAction,
  deleteManagerProxyAction,
} from '@/app/actions/manager-proxies'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import type { Proxy, ProxyKind } from '@/lib/types'

const STATUS_COLOR: Record<Proxy['status'], string> = {
  ok: 'bg-success',
  error: 'bg-destructive',
  unknown: 'bg-muted-foreground',
}

const STATUS_LABEL: Record<Proxy['status'], string> = {
  ok: 'Работает',
  error: 'Не работает',
  unknown: 'Не проверен',
}

/**
 * Manager self-service proxy management. Two groups:
 *   - "Мои прокси": full CRUD (add / test / delete) — owned by the manager.
 *   - "Назначенные админом": read-only, the manager may only run a health check.
 */
export function ProxiesManager({
  owned,
  assigned,
}: {
  owned: Proxy[]
  assigned: Proxy[]
}) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<ProxyKind>('socks5')
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)

  function submit(formData: FormData) {
    formData.set('kind', kind)
    startTransition(async () => {
      const res = await createManagerProxyAction(formData)
      if (res.ok) {
        toast.success(res.message)
        setOpen(false)
        setKind('socks5')
      } else {
        toast.error(res.message)
      }
    })
  }

  function check(id: string) {
    setBusyId(id)
    startTransition(async () => {
      const res = await checkManagerProxyAction(id)
      res.ok ? toast.success(res.message) : toast.error(res.message)
      setBusyId(null)
    })
  }

  function remove(id: string) {
    setBusyId(id)
    startTransition(async () => {
      const res = await deleteManagerProxyAction(id)
      res.ok ? toast.success(res.message) : toast.error(res.message)
      setBusyId(null)
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Globe className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">Мои прокси</h2>
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {owned.length}
            </span>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger
              render={
                <Button size="sm">
                  <Plus className="size-4" />
                  Добавить прокси
                </Button>
              }
            />
            <DialogContent className="sm:max-w-md">
              <form action={submit}>
                <DialogHeader>
                  <DialogTitle>Добавить прокси</DialogTitle>
                  <DialogDescription>
                    Прокси будет доступен только вам и сразу появится в мастере
                    подключения. Учётные данные шифруются.
                  </DialogDescription>
                </DialogHeader>
                <div className="my-4 flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="mpx-label">Название</Label>
                    <Input
                      id="mpx-label"
                      name="label"
                      placeholder="Мой EU прокси"
                      required
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-2">
                      <Label>Тип</Label>
                      <Select
                        value={kind}
                        onValueChange={(v) => setKind(v as ProxyKind)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="socks5">SOCKS5</SelectItem>
                          <SelectItem value="http">HTTP</SelectItem>
                          <SelectItem value="mtproto">MTProto</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="mpx-port">Порт</Label>
                      <Input
                        id="mpx-port"
                        name="port"
                        type="number"
                        placeholder="1080"
                        required
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="mpx-host">Хост</Label>
                    <Input
                      id="mpx-host"
                      name="host"
                      placeholder="1.2.3.4"
                      required
                    />
                  </div>
                  {kind === 'mtproto' ? (
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="mpx-secret">Секрет</Label>
                      <Input
                        id="mpx-secret"
                        name="secret"
                        placeholder="ee..."
                        className="font-mono text-sm"
                        required
                      />
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="mpx-user">Логин</Label>
                        <Input
                          id="mpx-user"
                          name="username"
                          placeholder="необязательно"
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="mpx-pass">Пароль</Label>
                        <Input
                          id="mpx-pass"
                          name="password"
                          type="password"
                          placeholder="необязательно"
                        />
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setOpen(false)}
                  >
                    Отмена
                  </Button>
                  <Button type="submit" disabled={pending}>
                    {pending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : null}
                    Добавить
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {owned.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            У вас пока нет своих прокси. Добавьте прокси, чтобы маршрутизировать
            подключения Telegram/WhatsApp через нужный IP.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {owned.map((p) => {
              const busy = pending && busyId === p.id
              return (
                <Card key={p.id} className="flex flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                        <Globe className="size-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                          {p.label}
                          {p.hasAuth ? (
                            <Lock className="size-3 text-muted-foreground" />
                          ) : null}
                        </p>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {p.kind}://{p.host}:{p.port}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span
                        className={`size-1.5 rounded-full ${STATUS_COLOR[p.status]}`}
                        aria-hidden="true"
                      />
                      <span className="text-xs text-muted-foreground">
                        {STATUS_LABEL[p.status]}
                      </span>
                    </div>
                  </div>

                  {p.lastError ? (
                    <p className="break-words rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                      {p.lastError}
                    </p>
                  ) : null}

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => check(p.id)}
                      disabled={busy}
                    >
                      {busy ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <RefreshCw className="size-4" />
                      )}
                      Проверить
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Удалить ${p.label}`}
                      onClick={() => remove(p.id)}
                      disabled={busy}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Назначенные админом</h2>
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {assigned.length}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Эти прокси назначил администратор. Вы можете использовать их при
          подключении и проверять связь, но не можете изменять или удалять.
        </p>

        {assigned.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            Администратор пока не назначил вам прокси.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {assigned.map((p) => {
              const busy = pending && busyId === p.id
              return (
                <Card key={p.id} className="flex flex-col gap-3 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                        <Globe className="size-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                          {p.label}
                          {p.hasAuth ? (
                            <Lock className="size-3 text-muted-foreground" />
                          ) : null}
                        </p>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {p.kind}://{p.host}:{p.port}
                        </p>
                      </div>
                    </div>
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${STATUS_COLOR[p.status]}`}
                      aria-hidden="true"
                      title={STATUS_LABEL[p.status]}
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => check(p.id)}
                    disabled={busy}
                  >
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RefreshCw className="size-4" />
                    )}
                    Проверить связь
                  </Button>
                </Card>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
