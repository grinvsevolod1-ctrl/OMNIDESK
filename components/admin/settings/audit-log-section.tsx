import { ScrollText } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { listAudit, type AuditRow } from '@/lib/data/audit'

/**
 * "Журнал действий" card for admin settings: the freshest audit entries,
 * newest first. Read-only accountability view — who logged in, who moved a
 * dialog, who touched AI settings. Server component; a page refresh is the
 * natural update model on a settings page.
 */

const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Вход в систему',
  'manager.create': 'Создан сотрудник',
  'manager.delete': 'Удалён сотрудник',
  'manager.block': 'Сотрудник заблокирован',
  'manager.unblock': 'Сотрудник разблокирован',
  'manager.password_reset': 'Сброс пароля сотрудника',
  'account.password_change': 'Смена своего пароля',
  'conversation.transfer': 'Передача диалога',
  'ai.settings.update': 'Изменены настройки ИИ',
}

const ROLE_LABELS: Record<AuditRow['actorRole'], string> = {
  admin: 'Админ',
  manager: 'Менеджер',
  curator: 'Менеджер по кадрам',
  head: 'Руководитель',
  buyer: 'Медиабайер',
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export async function AuditLogSection({
  bare = false,
}: {
  /** Без собственного заголовка секции — имя даёт вкладка настроек. */
  bare?: boolean
} = {}) {
  const page = await listAudit({ limit: 30, offset: 0 })

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {!bare ? (
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Журнал действий
          </h2>
        ) : null}
        <span className="text-xs text-muted-foreground">
          всего {page.total}
        </span>
      </div>

      <Card className="overflow-hidden">
        {page.rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-8 text-center">
            <ScrollText className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Записей пока нет. Действия сотрудников и входы в систему появятся
              здесь автоматически.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {page.rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:gap-3"
              >
                <span className="w-full shrink-0 font-mono text-xs text-muted-foreground sm:w-24">
                  {fmtWhen(row.createdAt)}
                </span>
                <Badge
                  variant="outline"
                  className="w-fit shrink-0 text-xs font-normal"
                >
                  {ROLE_LABELS[row.actorRole]}
                </Badge>
                <span className="min-w-0 truncate text-sm font-medium">
                  {row.actorLabel}
                </span>
                <span className="min-w-0 truncate text-sm text-muted-foreground sm:ml-auto sm:text-right">
                  {ACTION_LABELS[row.action] ?? row.action}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        Журнал хранится 180 дней и очищается автоматически. Записываются входы,
        управление сотрудниками, передача диалогов и изменения настроек ИИ.
      </p>
    </section>
  )
}
