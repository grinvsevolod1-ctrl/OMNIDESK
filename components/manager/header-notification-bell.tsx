'use client'

import { useState } from 'react'
import { Bell, BellRing, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useNotifications } from '@/components/manager/notification-provider'
import {
  isSoundEnabled,
  playNotificationSound,
  setSoundEnabled,
} from '@/lib/local-notify'

/**
 * Compact notification control in the dashboard header. A dropdown with the
 * push-subscription action plus the in-tab sound toggle, so a manager can
 * manage both kinds of notifications from one place.
 */
export function HeaderNotificationBell() {
  const { ready, busy, loading, support, permission, enable } =
    useNotifications()
  // Lazily read from localStorage on first render (client component).
  const [sound, setSound] = useState<boolean>(() => isSoundEnabled())

  if (loading) {
    return (
      <Button variant="ghost" size="icon-sm" disabled aria-label="Уведомления">
        <Loader2 className="size-4 animate-spin" />
      </Button>
    )
  }

  const canEnable = support === 'ok' && permission !== 'denied'

  const pushLabel = ready
    ? 'Push-уведомления включены'
    : canEnable
      ? 'Включить push-уведомления'
      : permission === 'denied'
        ? 'Push заблокирован в браузере'
        : 'Push недоступен на этом устройстве'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Настройки уведомлений"
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
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Уведомления</DropdownMenuLabel>
        <DropdownMenuItem
          disabled={busy || ready || !canEnable}
          onClick={() => {
            if (!ready && canEnable) void enable()
          }}
        >
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              ready ? 'bg-emerald-500' : 'bg-amber-500',
            )}
            aria-hidden="true"
          />
          {pushLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={sound}
          onCheckedChange={(checked) => {
            const next = Boolean(checked)
            setSound(next)
            setSoundEnabled(next)
            // Instant feedback so the manager hears what they just enabled.
            if (next) playNotificationSound()
          }}
        >
          Звук при новом сообщении
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
