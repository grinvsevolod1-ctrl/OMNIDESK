'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  Boxes,
  ChevronRight,
  Cpu,
  GitBranch,
  HardDrive,
  Loader2,
  MemoryStick,
  Plus,
  RefreshCw,
  ServerCog,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  createAppAction,
  deleteServerAction,
  testServerAction,
} from '@/app/actions/hosting'
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
import { cn } from '@/lib/utils'
import type { AppRuntime, HostingApp, HostingServer } from '@/lib/types'
import {
  APP_STATUS_DOT,
  APP_STATUS_LABEL,
  RUNTIME_LABEL,
  SERVER_STATUS_DOT,
  SERVER_STATUS_LABEL,
  fmtPct,
  usageColor,
} from './shared'

export function ServerDetail({
  server,
  apps,
}: {
  server: HostingServer
  apps: HostingApp[]
}) {
  const router = useRouter()
  const [addOpen, setAddOpen] = useState(false)
  const [runtime, setRuntime] = useState<AppRuntime>('node')
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<'test' | 'delete' | 'add' | null>(null)

  function test() {
    setBusy('test')
    startTransition(async () => {
      const res = await testServerAction(server.id)
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
      setBusy(null)
      router.refresh()
    })
  }

  function remove() {
    if (!confirm(`Удалить сервер «${server.name}» и все его приложения?`)) return
    setBusy('delete')
    startTransition(async () => {
      const res = await deleteServerAction(server.id)
      if (res.ok) {
        toast.success(res.message)
        router.push('/admin/servers')
      } else {
        toast.error(res.message)
        setBusy(null)
      }
    })
  }

  function submitApp(formData: FormData) {
    formData.set('runtime', runtime)
    setBusy('add')
    startTransition(async () => {
      const res = await createAppAction(server.id, formData)
      if (res.ok) {
        toast.success(res.message)
        setAddOpen(false)
        setRuntime('node')
        router.refresh()
      } else {
        toast.error(res.message)
      }
      setBusy(null)
    })
  }

  const m = server.metrics

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/admin/servers"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Все серверы
      </Link>

      {/* Server header */}
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
              <ServerCog className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-lg font-semibold">{server.name}</h2>
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      SERVER_STATUS_DOT[server.status],
                    )}
                    aria-hidden="true"
                  />
                  <span className="text-xs text-muted-foreground">
                    {SERVER_STATUS_LABEL[server.status]}
                  </span>
                </span>
              </div>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {server.sshUsername}@{server.ipAddress}:{server.sshPort} ·{' '}
                {server.authType === 'ssh_key' ? 'SSH-ключ' : 'пароль'}
                {server.hostKeyPinned ? ' · host key закреплён' : ''}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={test}
              disabled={pending}
            >
              {busy === 'test' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Проверить связь
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={remove}
              disabled={pending}
              className="text-destructive hover:text-destructive"
            >
              {busy === 'delete' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Удалить
            </Button>
          </div>
        </div>

        {server.lastError ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {server.lastError}
          </p>
        ) : null}

        <div className="grid grid-cols-3 gap-3">
          <Metric icon={Cpu} label="CPU" value={m.cpu} />
          <Metric icon={MemoryStick} label="RAM" value={m.mem} />
          <Metric icon={HardDrive} label="Диск" value={m.disk} />
        </div>
        {m.uptime ? (
          <p className="text-xs text-muted-foreground">Аптайм: {m.uptime}</p>
        ) : null}
      </Card>

      {/* Apps */}
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Boxes className="size-4" />
          Приложения
        </h3>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger
            render={
              <Button size="sm">
                <Plus className="size-4" />
                Добавить приложение
              </Button>
            }
          />
          <DialogContent className="sm:max-w-md">
            <form action={submitApp}>
              <DialogHeader>
                <DialogTitle>Новое приложение</DialogTitle>
                <DialogDescription>
                  Приложение будет развёрнуто из Git-репозитория на этом сервере.
                </DialogDescription>
              </DialogHeader>
              <div className="my-4 flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="app-name">Название</Label>
                  <Input id="app-name" name="name" placeholder="my-api" required />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="app-repo">Git-репозиторий</Label>
                  <Input
                    id="app-repo"
                    name="repoUrl"
                    placeholder="https://github.com/user/repo.git"
                    className="font-mono text-xs"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="app-branch">Ветка</Label>
                    <Input id="app-branch" name="branch" defaultValue="main" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label>Рантайм</Label>
                    <Select
                      value={runtime}
                      onValueChange={(v) => setRuntime(v as AppRuntime)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="node">Node.js</SelectItem>
                        <SelectItem value="docker">Docker</SelectItem>
                        <SelectItem value="static">Статика</SelectItem>
                        <SelectItem value="php">PHP</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="app-port">Порт</Label>
                    <Input
                      id="app-port"
                      name="port"
                      type="number"
                      placeholder="3000"
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="app-domain">Домен</Label>
                    <Input
                      id="app-domain"
                      name="domain"
                      placeholder="app.example.com"
                    />
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setAddOpen(false)}
                >
                  Отмена
                </Button>
                <Button type="submit" disabled={pending}>
                  {busy === 'add' ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : null}
                  Создать
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {apps.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          На этом сервере пока нет приложений. Добавьте первое из Git.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {apps.map((app) => (
            <Card key={app.id} className="transition-colors hover:border-foreground/20">
              <Link
                href={`/admin/servers/${server.id}/apps/${app.id}`}
                className="flex items-center gap-3 p-4"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{app.name}</span>
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'size-1.5 rounded-full',
                          APP_STATUS_DOT[app.status],
                        )}
                        aria-hidden="true"
                      />
                      <span className="text-xs text-muted-foreground">
                        {APP_STATUS_LABEL[app.status]}
                      </span>
                    </span>
                  </div>
                  <p className="flex items-center gap-2 truncate font-mono text-xs text-muted-foreground">
                    <GitBranch className="size-3 shrink-0" />
                    {app.branch} · {RUNTIME_LABEL[app.runtime]}
                    {app.domain ? ` · ${app.domain}` : ''}
                  </p>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            </Card>
          ))}
        </div>
      )}
    </div>
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
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </div>
      <p className="text-lg font-semibold tabular-nums">{fmtPct(value)}</p>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full', usageColor(value))}
          style={{ width: `${value ?? 0}%` }}
        />
      </div>
    </div>
  )
}
