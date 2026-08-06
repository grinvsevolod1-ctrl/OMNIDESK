import { MapPin, User } from 'lucide-react'
import { requireCurator } from '@/lib/auth'
import { listLeadCardsForCurator } from '@/lib/data/lead-cards'
import { EmptyState, PageHeader } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { APP_TIME_ZONE } from '@/lib/time'

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  })
}

export default async function CuratorLeadsPage() {
  const user = await requireCurator()
  const leads = await listLeadCardsForCurator(user.sub)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8">
      <PageHeader
        title="Мои лиды"
        description="Лиды, переданные вам менеджерами."
      />

      {leads.length === 0 ? (
        <EmptyState
          icon={User}
          title="Пока нет лидов"
          description="Когда менеджер заполнит карточку и передаст лид по вашему городу, он появится здесь."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {leads.map((lead) => (
            <Card key={lead.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">
                    {lead.fullName || 'Без имени'}
                  </p>
                  {lead.vacancy ? (
                    <p className="text-sm text-muted-foreground">{lead.vacancy}</p>
                  ) : null}
                </div>
                {lead.city ? (
                  <Badge
                    variant="outline"
                    className="shrink-0 gap-1 border-transparent bg-muted text-muted-foreground"
                  >
                    <MapPin className="size-3" />
                    {lead.city}
                  </Badge>
                ) : null}
              </div>

              <dl className="mt-3 grid gap-1.5 text-sm sm:grid-cols-2">
                {lead.phone ? (
                  <div>
                    <dt className="text-xs text-muted-foreground">Телефон</dt>
                    <dd>{lead.phone}</dd>
                  </div>
                ) : null}
                {lead.telegramUsername ? (
                  <div>
                    <dt className="text-xs text-muted-foreground">Telegram</dt>
                    <dd>@{lead.telegramUsername}</dd>
                  </div>
                ) : null}
                {lead.address ? (
                  <div className="sm:col-span-2">
                    <dt className="text-xs text-muted-foreground">Адрес</dt>
                    <dd>{lead.address}</dd>
                  </div>
                ) : null}
                <div>
                  <dt className="text-xs text-muted-foreground">Менеджер</dt>
                  <dd>{lead.managerName ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Передан</dt>
                  <dd>
                    {lead.transferredAt
                      ? formatDateTime(lead.transferredAt)
                      : '—'}
                  </dd>
                </div>
              </dl>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
