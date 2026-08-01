'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  Boxes,
  Cpu,
  HardDrive,
  Loader2,
  MemoryStick,
  Plus,
  Search,
  ServerCog,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { createServerAction } from '@/app/actions/hosting'
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
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { HostingServer, ServerAuthType } from '@/lib/types'
import {
  SERVER_STATUS_DOT,
  SERVER_STATUS_LABEL,
  fmtPct,
  usageColor,
} from './shared'

export function ServersAdmin({ servers }: { servers: HostingServer[] }) {
  const [open, setOpen] = useState(false)
  const [authType, setAuthType] = useState<ServerAuthType>('ssh_key')
  const [search, setSearch] = useState('')
  const [pending, startTransition] = useTransition()

  const stats = useMemo(() => {
    const online = servers.filter((s) => s.status === 'online').length
    const offline = servers.filter((s) => s.status === 'offline').length
    const apps = servers.reduce((n, s) => n + (s.appCount ?? 0), 0)
    return { total: servers.length, online, offline, apps }
  }, [servers])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return servers
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.ipAddress.toLowerCase().includes(q),
    )
  }, [servers, search])

  function submit(formData: FormData) {
    formData.set('authType', authType)
    startTransition(async () => {
      const res = await createServerAction(formData)
      if (res.ok) {
        toast.success(res.message)
        setOpen(false)
        setAuthType('ssh_key')
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={ServerCog} label="Всего серверов" value={stats.total} />
        <StatCard
          icon={ShieldCheck}
          label="В сети"
          value={stats.online}
          tone="success"
        />
        <StatCard
          icon={TriangleAlert}
          label="Не в сети"
          value={stats.offline}
          tone={stats.offline > 0 ? 'error' : 'default'}
        />
        <StatCard icon={Boxes} label="Приложений" value={stats.apps} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по имени или IP…"
            className="pl-8"
            aria-label="Поиск серверов"
          />
        </div>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger
            render={
              <Button>
                <Plus className="size-4" />
                Добавить сервер
              </Button>
            }
          />
          <DialogContent className="sm:max-w-md">
            <form action={submit}>
              <DialogHeader>
                <DialogTitle>Добавить сервер</DialogTitle>
                <DialogDescription>
                  Укажите SSH-доступ к VPS. Ключ или пароль шифруются и никогда
                  не покидают сервер в открытом виде.
                </DialogDescription>
              </DialogHeader>
              <div className="my-4 flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="srv-name">Название</Label>
                  <Input
                    id="srv-name"
                    name="name"
                    placeholder="Продакшн, Европа"
                    required
                  />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2 flex flex-col gap-2">
                    <Label htmlFor="srv-ip">IP-адрес или хост</Label>
                    <Input id="srv-ip" name="ipAddress" placeholder="1.2.3.4" required />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="srv-port">SSH-порт</Label>
                    <Input
                      id="srv-port"
                      name="sshPort"
                      type="number"
                      defaultValue={22}
                      required
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="srv-user">SSH-пользователь</Label>
                    <Input
                      id="srv-user"
                      name="sshUsername"
                      defaultValue="root"
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label>Авторизация</Label>
                    <Select
                      value={authType}
                      onValueChange={(v) => setAuthType(v as ServerAuthType)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ssh_key">SSH-ключ</SelectItem>
                        <SelectItem value="password">Пароль</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {authType === 'ssh_key' ? (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="srv-key">Приватный SSH-ключ</Label>
                    <Textarea
                      id="srv-key"
                      name="secret"
                      placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'}
                      className="h-28 font-mono text-xs"
                      required
                    />
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="srv-pass">Пароль SSH</Label>
                    <Input
                      id="srv-pass"
                      name="secret"
                      type="password"
                      placeholder="••••••••"
                      required
                    />
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Отмена
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Добавить
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          {servers.length === 0
            ? 'Серверов пока нет. Добавьте VPS, чтобы разворачивать на нём приложения из Git.'
            : 'Ничего не найдено.'}
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {filtered.map((s) => (
            <ServerCard key={s.id} server={s} />
          ))}
        </div>
      )}
    </div>
  )
}

function ServerCard({ server }: { server: HostingServer }) {
  const m = server.metrics
  return (
    <Card className="transition-colors hover:border-foreground/20">
      <Link href={`/admin/servers/${server.id}`} className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
              <ServerCog className="size-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{server.name}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {server.sshUsername}@{server.ipAddress}:{server.sshPort}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span
              className={cn('size-1.5 rounded-full', SERVER_STATUS_DOT[server.status])}
              aria-hidden="true"
            />
            <span className="text-xs text-muted-foreground">
              {SERVER_STATUS_LABEL[server.status]}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Metric icon={Cpu} label="CPU" value={m.cpu} />
          <Metric icon={MemoryStick} label="RAM" value={m.mem} />
          <Metric icon={HardDrive} label="Диск" value={m.disk} />
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {server.appCount ?? 0}{' '}
            {pluralApps(server.appCount ?? 0)}
          </span>
          {m.uptime ? <span className="truncate">{m.uptime}</span> : null}
        </div>
      </Link>
    </Card>
  )
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Cpu
  label: string
  value: number | null
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/20 p-2">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </div>
      <p className="text-sm font-semibold tabular-nums">{fmtPct(value)}</p>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full', usageColor(value))}
          style={{ width: `${value ?? 0}%` }}
        />
      </div>
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone = 'default',
}: {
  icon: typeof ServerCog
  label: string
  value: number
  tone?: 'default' | 'success' | 'error'
}) {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'error'
        ? 'text-destructive'
        : 'text-foreground'
  return (
    <Card className="flex flex-col gap-1 p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <p className={cn('text-2xl font-semibold tabular-nums', toneClass)}>{value}</p>
    </Card>
  )
}

function pluralApps(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'приложение'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'приложения'
  return 'приложений'
}
