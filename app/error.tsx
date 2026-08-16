'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, Copy, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

/**
 * Route-level error boundary for every segment under /app. Without this, any
 * exception thrown by a server component loader (e.g. the database being
 * unreachable, DATABASE_URL missing, or the worker health probe failing) would
 * crash the whole route with an unhandled error and a blank screen.
 *
 * Important production caveat: Next.js REDACTS `error.message` for errors that
 * happen during the server render — the client only receives a generic string
 * plus a stable `error.digest`. That means we cannot reliably classify the
 * cause (DB vs. other) from the message in production. So instead of pretending
 * to know, we show the digest prominently (it maps 1:1 to a line in the server
 * logs / `pm2 logs`), list the usual suspects, and offer a retry. In dev, where
 * the real message IS available, we surface it directly.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    // Full detail always goes to the browser console (and, for server errors,
    // the matching entry sits in the server log under the same digest).
    console.error('[panel] route error:', error)
  }, [error])

  // In production this is the redacted placeholder; in dev it's the real error.
  // We only show it when it looks like a genuine, human-readable message.
  const devMessage =
    error.message &&
    !/^an error occurred in the server/i.test(error.message) &&
    error.message.length < 300
      ? error.message
      : null

  function copyDetails() {
    const details = [
      error.digest ? `digest: ${error.digest}` : null,
      devMessage ? `message: ${devMessage}` : null,
    ]
      .filter(Boolean)
      .join('\n')
    if (!details) return
    void navigator.clipboard?.writeText(details).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <Card className="flex max-w-md flex-col items-center gap-4 p-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-full border border-destructive/30 bg-destructive/10">
          <AlertTriangle className="size-6 text-destructive" />
        </div>

        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold">Не удалось загрузить страницу</h2>
          <p className="text-sm text-muted-foreground text-pretty">
            Сервер не смог отрисовать эту страницу. Обычно причина одна из:
          </p>
        </div>

        <ul className="w-full space-y-1.5 rounded-lg border border-border bg-muted/30 p-3 text-left text-xs text-muted-foreground">
          <li>
            {'• '}Нет связи с базой данных — проверьте{' '}
            <code className="rounded bg-muted px-1 py-0.5">DATABASE_URL</code> и
            что Postgres доступен.
          </li>
          <li>
            {'• '}Не задана обязательная переменная окружения (см.{' '}
            <code className="rounded bg-muted px-1 py-0.5">.env.example</code>).
          </li>
          <li>
            {'• '}Приложение запущено на старой сборке — выполните{' '}
            <code className="rounded bg-muted px-1 py-0.5">pnpm build</code> и
            перезапустите процесс.
          </li>
        </ul>

        {devMessage ? (
          <p className="w-full break-words rounded-lg border border-destructive/20 bg-destructive/5 p-2 text-left font-mono text-xs text-destructive">
            {devMessage}
          </p>
        ) : null}

        {error.digest ? (
          <p className="text-xs text-muted-foreground/70">
            Код ошибки: <span className="font-mono">{error.digest}</span> — по
            нему найдёте детали в логах сервера (
            <code className="rounded bg-muted px-1 py-0.5">pm2 logs</code>).
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={reset} className="gap-2">
            <RefreshCw className="size-4" />
            Повторить
          </Button>
          {error.digest || devMessage ? (
            <Button variant="outline" onClick={copyDetails} className="gap-2">
              <Copy className="size-4" />
              {copied ? 'Скопировано' : 'Скопировать детали'}
            </Button>
          ) : null}
        </div>
      </Card>
    </div>
  )
}
