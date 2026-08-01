'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Terminal } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DeploymentStatus } from '@/lib/types'
import { DEPLOYMENT_STATUS_LABEL, isDeploymentActive } from './shared'

interface LogLine {
  seq: number
  stream: 'stdout' | 'stderr' | 'system'
  line: string
}

/**
 * Live deploy-log viewer backed by the SSE route. EventSource auto-sends
 * Last-Event-ID (the last seq) on reconnect, so the server resumes exactly where
 * it left off with no duplicate or lost lines. The stream self-closes once the
 * deployment reaches a terminal status.
 */
export function DeploymentLogs({
  deploymentId,
  initialStatus,
}: {
  deploymentId: string
  initialStatus: DeploymentStatus
}) {
  const [lines, setLines] = useState<LogLine[]>([])
  const [status, setStatus] = useState<DeploymentStatus>(initialStatus)
  const [connected, setConnected] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const seenSeq = useRef<Set<number>>(new Set())

  useEffect(() => {
    // This component is keyed by deploymentId in the parent, so it remounts
    // (with fresh state) whenever the selected deployment changes — no manual
    // reset needed here.
    const es = new EventSource(
      `/api/admin/hosting/deployments/${deploymentId}/logs`,
    )

    es.addEventListener('ready', () => setConnected(true))

    es.addEventListener('log', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as LogLine
        if (seenSeq.current.has(data.seq)) return
        seenSeq.current.add(data.seq)
        setLines((prev) => [...prev, data])
      } catch {
        /* ignore malformed frame */
      }
    })

    es.addEventListener('status', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          status: DeploymentStatus
        }
        setStatus(data.status)
      } catch {
        /* ignore */
      }
    })

    es.addEventListener('done', () => {
      es.close()
      setConnected(false)
    })

    es.onerror = () => {
      setConnected(false)
      // Once terminal there's nothing more to stream; stop retrying.
      if (!isDeploymentActive(status)) es.close()
    }

    return () => es.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deploymentId])

  // Auto-scroll to the newest line as logs arrive.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const active = isDeploymentActive(status)

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2">
        <span className="flex items-center gap-2 text-xs font-medium">
          <Terminal className="size-3.5" />
          Логи деплоя
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {active ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <span
              className={cn(
                'size-1.5 rounded-full',
                status === 'success' ? 'bg-success' : 'bg-destructive',
              )}
              aria-hidden="true"
            />
          )}
          {DEPLOYMENT_STATUS_LABEL[status]}
          {connected && active ? ' · подключено' : ''}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="h-80 overflow-y-auto bg-background p-3 font-mono text-xs leading-relaxed"
      >
        {lines.length === 0 ? (
          <p className="text-muted-foreground">
            {active ? 'Ожидание вывода…' : 'Нет логов для этого деплоя.'}
          </p>
        ) : (
          lines.map((l) => (
            <div
              key={l.seq}
              className={cn(
                'whitespace-pre-wrap break-all',
                l.stream === 'stderr' && 'text-destructive',
                l.stream === 'system' && 'text-primary',
              )}
            >
              {l.line}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
