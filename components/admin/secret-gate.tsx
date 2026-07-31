'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { KeyRound, Loader2, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { secretUnlockAction } from '@/app/actions/admin-secret'

/**
 * Second-factor unlock screen shown before the god-mode console when
 * SECRET_PANEL_PASSWORD is configured and the admin hasn't unlocked yet.
 */
export function SecretGate() {
  const router = useRouter()
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!passcode.trim() || pending) return
    setError(null)
    startTransition(async () => {
      const res = await secretUnlockAction(passcode)
      if (res.ok) {
        toast.success(res.message)
        setPasscode('')
        router.refresh()
      } else {
        setError(res.message)
        setPasscode('')
      }
    })
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card p-8 shadow-sm">
          <div className="flex size-14 items-center justify-center rounded-2xl border border-border bg-muted/40">
            <KeyRound className="size-6 text-foreground" />
          </div>
          <div className="text-center">
            <h1 className="text-lg font-semibold tracking-tight">Секретная панель</h1>
            <p className="mt-1 text-sm text-muted-foreground text-pretty">
              Введите секретный пароль, чтобы открыть god-режим.
            </p>
          </div>

          <form onSubmit={submit} className="flex w-full flex-col gap-3">
            <Input
              type="password"
              autoFocus
              autoComplete="off"
              placeholder="Секретный пароль"
              value={passcode}
              onChange={(e) => {
                setPasscode(e.target.value)
                if (error) setError(null)
              }}
              aria-invalid={!!error}
              aria-describedby={error ? 'gate-error' : undefined}
              className="text-center"
            />

            {error && (
              <div
                id="gate-error"
                role="alert"
                className="flex items-center justify-center gap-1.5 text-sm text-destructive"
              >
                <ShieldAlert className="size-4" />
                {error}
              </div>
            )}

            <Button
              type="submit"
              size="lg"
              className="press-scale gap-2"
              disabled={!passcode.trim() || pending}
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <KeyRound className="size-4" />
              )}
              Открыть доступ
            </Button>
          </form>
        </div>
      </div>
    </main>
  )
}
