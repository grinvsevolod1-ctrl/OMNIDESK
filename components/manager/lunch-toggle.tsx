'use client'

import { useState, useTransition } from 'react'
import { Coffee, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { setLunchAction } from '@/app/actions/account'

/**
 * Header control that lets a manager flip their "Я на обеде" status. While on
 * lunch, NEW incoming conversations are routed to other available managers
 * (round-robin); conversations the manager already handles are untouched.
 *
 * Optimistic: the button reflects the new state immediately and rolls back if
 * the server action fails.
 */
export function LunchToggle({ initialOnLunch }: { initialOnLunch: boolean }) {
  const [onLunch, setOnLunch] = useState(initialOnLunch)
  const [pending, startTransition] = useTransition()

  function toggle() {
    const next = !onLunch
    setOnLunch(next) // optimistic
    startTransition(async () => {
      const res = await setLunchAction(next)
      if (!res.ok) {
        setOnLunch(!next) // roll back
        toast.error(res.message)
        return
      }
      toast.success(res.message)
    })
  }

  const label = onLunch ? 'Вы на обеде' : 'Уйти на обед'

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={onLunch ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={onLunch}
            aria-label={label}
            disabled={pending}
            onClick={toggle}
            className={cn(
              'gap-1.5',
              onLunch && 'text-amber-600 dark:text-amber-500',
            )}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Coffee className="size-4" />
            )}
            <span className="hidden sm:inline">
              {onLunch ? 'На обеде' : 'Обед'}
            </span>
          </Button>
        }
      />
      <TooltipContent side="bottom">
        {onLunch
          ? 'Новые диалоги уходят другим менеджерам. Нажмите, чтобы вернуться.'
          : 'Уйти на обед — новые диалоги будут уходить другим менеджерам.'}
      </TooltipContent>
    </Tooltip>
  )
}
