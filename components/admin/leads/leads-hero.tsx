import { AlertTriangle, ContactRound, TrendingUp, Users } from 'lucide-react'
import { Card } from '@/components/ui/card'
import type { LeadCardStats } from '@/lib/data/lead-stats'
import { cn } from '@/lib/utils'

/**
 * Серверная hero-полоса вкладки «Лиды»: четыре ключевые метрики поверх
 * списка. Рендерится один раз на сервере (RSC) — ноль клиентского JS.
 * Живые цифры внутри списка обновляет пуллинг useLeadsData; hero — снимок
 * на момент загрузки страницы, чего достаточно для «взгляда сверху».
 */
export function LeadsHero({
  total,
  weekStats,
  orphanedCount,
  curatorsCount,
}: {
  /** Всего переданных лидов за всё время. */
  total: number
  /** Статистика за последние 7 дней (created/transferred + сегодня). */
  weekStats: LeadCardStats
  /** Лиды без активного менеджера по кадрам. */
  orphanedCount: number
  /** Активные менеджеры по кадрам, принимающие лиды. */
  curatorsCount: number
}) {
  const items: {
    label: string
    value: number
    hint: string
    icon: typeof ContactRound
    tone?: 'default' | 'destructive'
  }[] = [
    {
      label: 'Всего лидов',
      value: total,
      hint: 'переданы менеджерам по кадрам',
      icon: ContactRound,
    },
    {
      label: 'Сегодня',
      value: weekStats.transferredToday,
      hint: `за 7 дней: ${weekStats.transferred}`,
      icon: TrendingUp,
    },
    {
      label: 'Менеджеры по кадрам',
      value: curatorsCount,
      hint: 'активны и принимают лиды',
      icon: Users,
    },
    {
      label: 'Без менеджера',
      value: orphanedCount,
      hint: orphanedCount > 0 ? 'требуют передачи' : 'все лиды распределены',
      icon: AlertTriangle,
      tone: orphanedCount > 0 ? 'destructive' : 'default',
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((item) => {
        const Icon = item.icon
        const destructive = item.tone === 'destructive'
        return (
          <Card
            key={item.label}
            className={cn(
              'flex flex-row items-center gap-3 p-4',
              destructive && 'border-destructive/40',
            )}
          >
            <div
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-lg',
                destructive
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-primary/10 text-primary',
              )}
            >
              <Icon className="size-4" aria-hidden />
            </div>
            <div className="min-w-0">
              <p
                className={cn(
                  'text-xl font-semibold leading-tight tabular-nums',
                  destructive && 'text-destructive',
                )}
              >
                {item.value}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {item.label} · {item.hint}
              </p>
            </div>
          </Card>
        )
      })}
    </div>
  )
}
