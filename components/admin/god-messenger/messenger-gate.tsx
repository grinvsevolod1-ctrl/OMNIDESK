'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { KeyRound, Loader2, MessagesSquare, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { messengerUnlockAction } from '@/app/actions/messenger'

/**
 * Standalone unlock screen for the messenger PWA. Independent of admin login and
 * the god panel — a correct passcode is the only thing needed to enter.
 */
export function MessengerGate() {
  const router = useRouter()
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!passcode.trim() || pending) return
    setError(null)
    startTransition(async () => {
      const res = await messengerUnlockAction(passcode)
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
          <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <MessagesSquare className="size-7" />
          </div>
          <div className="text-center">
            <h1 className="text-lg font-semibold tracking-tight">Messages</h1>
            <p className="mt-1 text-sm text-muted-foreground text-pretty">
              Введите пароль, чтобы открыть мессенджер.
            </p>
          </div>

          <form onSubmit={submit} className="flex w-full flex-col gap-3">
            <Input
              type="password"
              autoFocus
              autoComplete="off"
              inputMode="text"
              placeholder="Пароль"
              value={passcode}
              onChange={(e) => {
                setPasscode(e.target.value)
                if (error) setError(null)
              }}
              aria-invalid={!!error}
              aria-describedby={error ? 'msg-gate-error' : undefined}
              className="text-center"
            />

            {error && (
              <div
                id="msg-gate-error"
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
              Войти
            </Button>
          </form>
        </div>
      </div>
    </main>
  )
}
