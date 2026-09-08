'use client'

import { useState } from 'react'
import { Loader2, LogIn } from 'lucide-react'
import { toast } from 'sonner'
import { startImpersonationAction } from '@/app/actions/admin-secret'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { Manager } from '@/lib/types'

/**
 * «Сессия» — open a live, already-authenticated view of a staff account in a
 * new tab for up to 5 minutes. A blank tab is opened synchronously inside the
 * click gesture (so the browser doesn't block the popup); once the server
 * action has minted the short-lived impersonation cookie we point that tab at
 * the account's home. The admin's own session is untouched — see
 * app/actions/admin-secret/impersonation.ts and lib/session.ts.
 */
export function ImpersonateButton({ account }: { account: Manager }) {
  const [busy, setBusy] = useState(false)

  function open() {
    if (busy) return
    setBusy(true)
    const tab =
      typeof window !== 'undefined' ? window.open('', '_blank') : null
    if (tab) {
      // A tiny placeholder so the user sees something while the cookie is set.
      tab.document.write(
        '<title>Открываем сессию…</title><body style="font-family:sans-serif;padding:24px">Открываем сессию…</body>',
      )
    }
    ;(async () => {
      try {
        const res = await startImpersonationAction(account.id)
        if (res.ok && res.home) {
          toast.success(res.message)
          if (tab) tab.location.href = res.home
          else window.location.href = res.home
        } else {
          if (tab) tab.close()
          toast.error(res.message)
        }
      } catch {
        if (tab) tab.close()
        toast.error('Не удалось открыть сессию')
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={busy}
            onClick={open}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <LogIn className="size-3.5" />
            )}
            Сессия
          </Button>
        }
      />
      <TooltipContent>
        Войти под аккаунтом в новой вкладке (на 5 минут, без включения
        уведомлений)
      </TooltipContent>
    </Tooltip>
  )
}
