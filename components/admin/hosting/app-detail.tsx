'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  GitBranch,
  Globe,
  History,
  Loader2,
  Play,
  RotateCcw,
  Rocket,
  Square,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  deleteAppAction,
  deployAction,
  lifecycleAction,
} from '@/app/actions/hosting'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type {
  HostingApp,
  HostingDeployment,
  HostingServer,
} from '@/lib/types'
import { DeploymentLogs } from './deployment-logs'
import { EnvEditor } from './env-editor'
import {
  APP_STATUS_DOT,
  APP_STATUS_LABEL,
  DEPLOYMENT_STATUS_DOT,
  DEPLOYMENT_STATUS_LABEL,
  RUNTIME_LABEL,
} from './shared'

type Busy = 'deploy' | 'start' | 'stop' | 'restart' | 'delete' | null

export function AppDetail({
  server,
  app,
  deployments,
}: {
  server: HostingServer
  app: HostingApp
  deployments: HostingDeployment[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<Busy>(null)
  // Which deployment's logs are shown. Default to the most recent one.
  const [activeDeployment, setActiveDeployment] = useState<string | null>(
    deployments[0]?.id ?? null,
  )
  const activeStatus =
    deployments.find((d) => d.id === activeDeployment)?.status ?? 'queued'

  function deploy() {
    setBusy('deploy')
    startTransition(async () => {
      const res = await deployAction(app.id)
      if (res.ok) {
        toast.success(res.message)
        if (res.deploymentId) setActiveDeployment(res.deploymentId)
        router.refresh()
      } else {
        toast.error(res.message)
      }
      setBusy(null)
    })
  }

  function lifecycle(action: 'start' | 'stop' | 'restart') {
    setBusy(action)
    startTransition(async () => {
      const res = await lifecycleAction(app.id, action)
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
      setBusy(null)
      router.refresh()
    })
  }

  function remove() {
    if (!confirm(`Удалить приложение «${app.name}» с сервера?`)) return
    setBusy('delete')
    startTransition(async () => {
      const res = await deleteAppAction(app.id)
      if (res.ok) {
        toast.success(res.message)
        router.push(`/admin/servers/${server.id}`)
      } else {
        toast.error(res.message)
        setBusy(null)
      }
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/admin/servers/${server.id}`}
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {server.name}
      </Link>

      {/* App header + actions */}
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{app.name}</h2>
              <span className="flex items-center gap-1.5">
                <span
                  className={cn('size-1.5 rounded-full', APP_STATUS_DOT[app.status])}
                  aria-hidden="true"
                />
                <span className="text-xs text-muted-foreground">
                  {APP_STATUS_LABEL[app.status]}
                </span>
              </span>
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <GitBranch className="size-3" />
                {app.branch}
              </span>
              <span>{RUNTIME_LABEL[app.runtime]}</span>
              {app.port ? <span>:{app.port}</span> : null}
              {app.domain ? (
                <span className="inline-flex items-center gap-1">
                  <Globe className="size-3" />
                  {app.domain}
                </span>
              ) : null}
            </p>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              {app.repoUrl}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={deploy} disabled={pending} size="sm">
              {busy === 'deploy' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Rocket className="size-4" />
              )}
              Деплой
            </Button>
            <Button
              onClick={() => lifecycle('start')}
              disabled={pending}
              variant="outline"
              size="sm"
            >
              {busy === 'start' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              Старт
            </Button>
            <Button
              onClick={() => lifecycle('stop')}
              disabled={pending}
              variant="outline"
              size="sm"
            >
              {busy === 'stop' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Square className="size-4" />
              )}
              Стоп
            </Button>
            <Button
              onClick={() => lifecycle('restart')}
              disabled={pending}
              variant="outline"
              size="sm"
            >
              {busy === 'restart' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              Рестарт
            </Button>
            <Button
              onClick={remove}
              disabled={pending}
              variant="outline"
              size="sm"
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

        {app.lastError ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {app.lastError}
          </p>
        ) : null}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Env editor */}
        <Card className="p-5">
          <EnvEditor appId={app.id} envKeys={app.envKeys} />
        </Card>

        {/* Deploy history */}
        <Card className="flex flex-col gap-3 p-5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <History className="size-4" />
            История деплоев
          </div>
          {deployments.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Деплоев ещё не было. Нажмите «Деплой», чтобы развернуть приложение.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {deployments.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setActiveDeployment(d.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors',
                    d.id === activeDeployment
                      ? 'border-foreground/30 bg-muted/40'
                      : 'border-border hover:bg-muted/30',
                  )}
                >
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      DEPLOYMENT_STATUS_DOT[d.status],
                    )}
                    aria-hidden="true"
                  />
                  <span className="font-medium">
                    {DEPLOYMENT_STATUS_LABEL[d.status]}
                  </span>
                  {d.commitHash ? (
                    <span className="font-mono text-muted-foreground">
                      {d.commitHash}
                    </span>
                  ) : null}
                  <span className="ml-auto text-muted-foreground">
                    {new Date(d.createdAt).toLocaleString('ru-RU', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Live logs for the selected deployment */}
      {activeDeployment ? (
        <DeploymentLogs
          key={activeDeployment}
          deploymentId={activeDeployment}
          initialStatus={activeStatus}
        />
      ) : null}
    </div>
  )
}
