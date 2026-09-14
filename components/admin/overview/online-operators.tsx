'use client'

import { Card } from '@/components/ui/card'
import { initials } from '@/lib/initials'
import {
  useOnlineOperators,
  type OperatorRole,
} from '@/lib/hooks/use-operator-presence'

const ROLE_LABEL: Record<OperatorRole, string> = {
  manager: 'Менеджер',
  curator: 'Менеджер по кадрам',
  head: 'Руководитель',
}

/**
 * Живая панель «Кто на смене» для админа. Слушает эфемерные presence-события
 * операторов (open-вкладка шлёт heartbeat), держит их в памяти с TTL и
 * показывает список онлайн-сотрудников. Никаких запросов к БД — только
 * подписка на общий SSE. Пустой список — нормальное состояние (никто не в
 * панели прямо сейчас или heartbeat'ы ещё не пришли после открытия экрана).
 */
export function OnlineOperators() {
  const operators = useOnlineOperators()

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight">На смене</h2>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="relative flex size-2">
            {operators.length > 0 ? (
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/60" />
            ) : null}
            <span
              className={
                operators.length > 0
                  ? 'relative inline-flex size-2 rounded-full bg-success'
                  : 'relative inline-flex size-2 rounded-full bg-muted-foreground/40'
              }
            />
          </span>
          {operators.length}
        </span>
      </div>

      {operators.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Сейчас никого нет в панели.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {operators.map((op) => (
            <li key={op.id} className="flex items-center gap-2.5">
              <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground">
                {initials(op.name)}
                <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card bg-success" />
              </span>
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-sm font-medium">{op.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {ROLE_LABEL[op.role]}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
