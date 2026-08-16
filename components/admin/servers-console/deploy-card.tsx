'use client'

import { memo, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Loader2, Rocket, Server, Square, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cancelAiDeployAction } from '@/app/actions/hosting-console'
import type { LaunchedDeploy, OpenPanel } from '@/lib/servers-console/assistant'
import type { HostingServer } from '@/lib/types'
import { DeploymentLogs } from '@/components/admin/hosting/deployment-logs'
import dynamic from 'next/dynamic'

// The full servers table (with its dialogs and forms) is only needed when the
// assistant opens an inline panel — keep it out of the console's initial chunk
// so the chat itself loads faster.
const ServersAdmin = dynamic(
  () =>
    import('@/components/admin/hosting/servers-admin').then(
      (m) => m.ServersAdmin,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    ),
  },
)

/* --------------------------- Live deploy card --------------------------- */

/**
 * The autonomous deploy launcher: shows what the agent is installing and embeds
 * the live log stream so the admin watches every step in real time, with a Stop
 * button to cancel mid-flight.
 */
export const DeployCard = memo(function DeployCard({
  deploy,
}: {
  deploy: LaunchedDeploy
}) {
  const [canceled, setCanceled] = useState(false)
  const [busy, setBusy] = useState(false)

  const cancel = async () => {
    setBusy(true)
    try {
      const res = await cancelAiDeployAction(deploy.deploymentId)
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      setCanceled(true)
    } catch {
      toast.error('Не удалось отменить установку.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="ml-9 flex flex-col gap-3 border-primary/20 p-4 duration-300 animate-in fade-in slide-in-from-top-1">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 rounded-md bg-primary/10 p-1.5 text-primary">
            <Rocket className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium">
              ИИ разворачивает «{deploy.appName}» на {deploy.serverName}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {deploy.repoUrl}
              {deploy.domain ? ` → ${deploy.domain}` : ''}
            </p>
          </div>
        </div>
        {!canceled ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={cancel}
            disabled={busy}
            className="shrink-0 gap-1.5 text-muted-foreground"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Square className="size-3.5" />
            )}
            Остановить
          </Button>
        ) : null}
      </div>
      {deploy.domain ? (
        <a
          href={`https://${deploy.domain}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1.5 text-xs text-primary hover:underline"
        >
          <ExternalLink className="size-3.5" />
          {`https://${deploy.domain}`}
        </a>
      ) : null}
      <DeploymentLogs
        deploymentId={deploy.deploymentId}
        initialStatus="queued"
      />
    </Card>
  )
})

/* ------------------------------ Inline panel ---------------------------- */

export const InlinePanel = memo(function InlinePanel({
  panel,
  servers,
  onClose,
}: {
  panel: OpenPanel
  servers: HostingServer[]
  onClose: () => void
}) {
  return (
    <Card className="ml-9 flex flex-col gap-3 border-primary/20 p-4 duration-300 animate-in fade-in slide-in-from-top-1">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-primary/10 p-1.5 text-primary">
            <Server className="size-4" />
          </span>
          <p className="text-sm font-medium">
            {panel.kind === 'servers'
              ? 'Серверы'
              : panel.kind === 'server'
                ? 'Сервер'
                : 'Приложение'}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="shrink-0 gap-1.5"
        >
          <X className="size-4" />
          Закрыть
        </Button>
      </div>
      {panel.kind === 'servers' ? (
        <ServersAdmin servers={servers} />
      ) : panel.kind === 'server' ? (
        <PanelLink href={`/admin/servers/${panel.id}`} label="Открыть сервер" />
      ) : (
        <PanelLink
          href={`/admin/servers/${panel.serverId}/apps/${panel.id}`}
          label="Открыть приложение"
        />
      )}
    </Card>
  )
})

function PanelLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted/60"
    >
      <ExternalLink className="size-4" />
      {label}
    </Link>
  )
}
