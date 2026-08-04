'use client'

/**
 * Hosting panels for the copilot feed: the VPS fleet table (row click drills
 * into that server's apps) and the per-server app list with one-tap deploy.
 */

import { asArray, EmptyNote, pct, SimpleTable } from './shared'

interface ServerViewRow {
  id: string
  name: string
  ip: string
  status: string
  statusLabel: string
  cpu: number | null
  memory: number | null
  disk: number | null
  uptime: string | null
  apps: number
  lastError: string | null
}

export function ServersPanel({
  payload,
  onCommand,
}: {
  payload: unknown
  onCommand?: (prompt: string) => void
}) {
  const rows = asArray<ServerViewRow>(payload).filter((r) => r?.id)
  if (rows.length === 0) return <EmptyNote />
  return (
    <SimpleTable
      head={['Сервер', 'IP', 'Статус', 'CPU', 'RAM', 'Диск', 'Приложения']}
      onRowClick={
        onCommand
          ? (i) => onCommand(`Покажи приложения на сервере ${rows[i].name}`)
          : undefined
      }
      rows={rows.map((s) => [
        <span key="n" className="font-medium">
          {s.name}
        </span>,
        <span key="ip" className="font-mono text-xs">
          {s.ip}
        </span>,
        <span
          key="st"
          className={
            s.status === 'online'
              ? 'text-foreground'
              : s.status === 'error' || s.status === 'offline'
                ? 'text-destructive'
                : 'text-muted-foreground'
          }
        >
          {s.statusLabel}
        </span>,
        pct(s.cpu),
        pct(s.memory),
        pct(s.disk),
        String(s.apps),
      ])}
    />
  )
}

interface AppViewRow {
  id: string
  name: string
  status: string
  statusLabel: string
  domain: string | null
  branch: string
  autoDeploy: boolean
  lastDeployStatus: string | null
  lastDeployAt: string | null
  lastError: string | null
}

export function AppsPanel({
  payload,
  onCommand,
}: {
  payload: unknown
  onCommand?: (prompt: string) => void
}) {
  const rows = asArray<AppViewRow>(payload).filter((r) => r?.id)
  if (rows.length === 0) return <EmptyNote />
  return (
    <SimpleTable
      head={['Приложение', 'Статус', 'Домен', 'Ветка', 'Автодеплой', '']}
      rows={rows.map((a) => [
        <span key="n" className="font-medium">
          {a.name}
        </span>,
        <span
          key="st"
          className={
            a.status === 'running'
              ? 'text-foreground'
              : a.status === 'error'
                ? 'text-destructive'
                : 'text-muted-foreground'
          }
        >
          {a.statusLabel}
        </span>,
        a.domain ? (
          <span key="d" className="font-mono text-xs">
            {a.domain}
          </span>
        ) : (
          '—'
        ),
        <span key="b" className="font-mono text-xs">
          {a.branch}
        </span>,
        a.autoDeploy ? 'вкл' : 'выкл',
        onCommand ? (
          <button
            key="deploy"
            type="button"
            onClick={() => onCommand(`Задеплой приложение ${a.name} (${a.id})`)}
            className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
          >
            Деплой
          </button>
        ) : null,
      ])}
    />
  )
}
