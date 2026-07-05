'use client'

import { Bell, BellRing, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useNotifications } from '@/components/manager/notification-provider'

/**
 * Compact notification status control that lives in the dashboard header
 * (next to the manager identity). Replaces the old floating bell that overlapped
 * the inbox composer's send button.
 */
export function HeaderNotificationBell() {
  const { ready, busy, loading, support, permission, enable } =
    useNotifications()

  if (loading) {
    return (
      <Button variant="ghost" size="icon-sm" disabled aria-label="Уведомления">
        <Loader2 className="size-4 animate-spin" />
      </Button>
    )
  }

  const canEnable = support === 'ok' && permission !== 'denied'

  const label = ready
    ? 'Уведомления включены'
    : canEnable
      ? 'Включить уведомления'
      : 'Уведомления недоступны'

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            disabled={busy || (!ready && !canEnable)}
            onClick={() => {
              if (!ready && canEnable) void enable()
            }}
            className="relative"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : ready ? (
              <BellRing className="size-4" />
            ) : (
              <Bell className="size-4" />
            )}
            <span
              className={cn(
                'absolute right-1 top-1 size-2 rounded-full ring-2 ring-background',
                ready ? 'bg-emerald-500' : 'bg-amber-500',
              )}
              aria-hidden="true"
            />
          </Button>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
