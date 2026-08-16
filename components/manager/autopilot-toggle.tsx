'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { Bot } from 'lucide-react'
import { setAutopilotEnabledAction } from '@/app/actions/autopilot'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

export interface AutopilotToggleProps {
  /** Initial master on/off state, read on the server. */
  initialEnabled: boolean
  /** Number of active rules, shown as a hint next to the switch. */
  enabledCount: number
  className?: string
}

/**
 * Compact master on/off switch for the autopilot, designed to live in the inbox
 * toolbar. Flips the per-manager `autopilot_settings.enabled` flag via a server
 * action. The detailed rule builder lives on the dedicated /app/autopilot page,
 * which this control links to.
 */
export function AutopilotToggle({
  initialEnabled,
  enabledCount,
  className,
}: AutopilotToggleProps) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [pending, startTransition] = useTransition()

  function onToggle(next: boolean) {
    // Optimistic flip; revert if the action reports failure.
    setEnabled(next)
    startTransition(async () => {
      const res = await setAutopilotEnabledAction(next)
      if (!res.ok) setEnabled(!next)
    })
  }

  const hint =
    enabledCount > 0
      ? `${enabledCount} ${pluralRules(enabledCount)}`
      : 'нет правил'

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5',
        className,
      )}
    >
      <Bot
        className={cn(
          'size-4 shrink-0',
          enabled ? 'text-primary' : 'text-muted-foreground',
        )}
        aria-hidden
      />
      <div className="flex min-w-0 flex-col leading-tight">
        <Link
          href="/app/autopilot"
          className="text-xs font-medium hover:underline"
        >
          Автопилот
        </Link>
        <span className="text-[10px] text-muted-foreground">
          {enabled ? hint : 'выключен'}
        </span>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        disabled={pending}
        aria-label="Включить автопилот"
        className="ml-1"
      />
    </div>
  )
}

function pluralRules(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'правило'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'правила'
  return 'правил'
}
