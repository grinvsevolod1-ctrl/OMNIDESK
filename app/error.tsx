'use client'

import { useEffect } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

/**
 * Route-level error boundary for every segment under /app. Without this, any
 * exception thrown by a server component loader (e.g. the database being
 * unreachable, DATABASE_URL missing, or the worker health probe failing) would
 * crash the whole route with an unhandled error and a blank screen — which is
 * exactly what "the accounts page won't open" looks like. Here we catch it,
 * show a readable message, and offer a retry that re-runs the server render.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[panel] route error:', error)
  }, [error])

  const isDbError = /DATABASE_URL|database|ECONNREFUSED|connect|pg|postgres/i.test(
    error.message,
  )

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <Card className="flex max-w-md flex-col items-center gap-4 p-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-full border border-destructive/30 bg-destructive/10">
          <AlertTriangle className="size-6 text-destructive" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold">Не удалось загрузить страницу</h2>
          <p className="text-sm text-muted-foreground">
            {isDbError
              ? 'Нет связи с базой данных. Проверьте переменную DATABASE_URL и доступность Postgres, затем повторите.'
              : 'Произошла ошибка при загрузке данных. Попробуйте обновить страницу.'}
          </p>
          {error.digest ? (
            <p className="text-xs text-muted-foreground/70">
              Код ошибки: {error.digest}
            </p>
          ) : null}
        </div>
        <Button onClick={reset} className="gap-2">
          <RefreshCw className="size-4" />
          Повторить
        </Button>
      </Card>
    </div>
  )
}
