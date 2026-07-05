'use client'

import { useEffect } from 'react'

/**
 * Last-resort boundary that also replaces the root layout when the error occurs
 * during the root layout render itself (a segment error.tsx can't catch that).
 * Must render its own <html>/<body>. Intentionally dependency-free so it works
 * even if the failure happened while loading shared providers.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[panel] global error:', error)
  }, [error])

  return (
    <html lang="ru" className="dark">
      <body className="bg-background text-foreground font-sans antialiased">
        <div className="flex min-h-screen items-center justify-center p-6">
          <div className="flex max-w-md flex-col items-center gap-4 rounded-xl border border-border bg-card p-8 text-center">
            <h2 className="text-lg font-semibold">Что-то пошло не так</h2>
            <p className="text-sm text-muted-foreground">
              Приложение не смогло отобразить страницу. Обновите её или
              попробуйте позже.
            </p>
            {error.digest ? (
              <p className="text-xs text-muted-foreground/70">
                Код ошибки: {error.digest}
              </p>
            ) : null}
            <button
              onClick={reset}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Повторить
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
