'use client'

import { useState } from 'react'
import { MapPin, Pencil } from 'lucide-react'
import { CuratorLeadsDialog } from '@/components/admin/curator-leads-dialog'
import { EditCuratorCitiesDialog } from '@/components/admin/edit-curator-cities-dialog'
import { ManagerActions } from '@/components/admin/manager-actions'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import type {
  CuratorDiscipline,
  CuratorDisciplineHistory,
} from '@/lib/data/lead-cards'
import { formatMskDate as formatDate } from '@/lib/time'
import type { Manager } from '@/lib/types'

function StatusPill({ status }: { status: Manager['status'] }) {
  return (
    <Badge
      variant="outline"
      className={
        status === 'active'
          ? 'gap-1.5 border-transparent bg-success/15 text-success'
          : 'gap-1.5 border-transparent bg-muted text-muted-foreground'
      }
    >
      <span
        className={
          status === 'active'
            ? 'size-1.5 rounded-full bg-success'
            : 'size-1.5 rounded-full bg-muted-foreground'
        }
      />
      {status === 'active' ? 'Активен' : 'Заблокирован'}
    </Badge>
  )
}

function CityPill({ city }: { city: string }) {
  return (
    <Badge
      variant="outline"
      className="gap-1.5 border-transparent bg-muted text-muted-foreground"
    >
      <MapPin className="size-3" />
      {city}
    </Badge>
  )
}

function DisciplinePill({
  d,
  h,
}: {
  d: CuratorDiscipline | undefined
  h?: CuratorDisciplineHistory
}) {
  if (!d || d.totalLeads === 0) {
    return <span className="text-xs text-muted-foreground">Нет лидов</span>
  }
  const allDone = d.pendingToday === 0
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge
        variant="outline"
        className={
          allDone
            ? 'gap-1.5 border-transparent bg-success/15 text-success'
            : 'gap-1.5 border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400'
        }
        title="Подтверждено статусов сегодня / всего лидов"
      >
        {d.confirmedToday}/{d.totalLeads} сегодня
      </Badge>
      {h && h.totalConfirms > 0 ? (
        <Badge
          variant="outline"
          className="gap-1.5 border-transparent bg-muted text-muted-foreground"
          title={`За 30 дней: ${h.onTimeConfirms} из ${h.totalConfirms} подтверждений до 10:00 МСК, активных дней: ${h.activeDays}`}
        >
          {h.onTimeRatePct}% вовремя · 30 дн.
        </Badge>
      ) : null}
    </div>
  )
}

export function CuratorsTable({
  curators,
  discipline,
  history,
  citiesById,
}: {
  curators: Manager[]
  discipline?: Record<string, CuratorDiscipline>
  history?: Record<string, CuratorDisciplineHistory>
  /** All covered cities per curator (curator_cities, migration 115). */
  citiesById?: Record<string, string[]>
}) {
  const [selected, setSelected] = useState<Manager | null>(null)
  const [editingCities, setEditingCities] = useState<Manager | null>(null)

  return (
    <>
      <Card className="hidden overflow-hidden md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-3 font-medium">Имя</th>
              <th className="px-5 py-3 font-medium">Город</th>
              <th className="px-5 py-3 font-medium">Дисциплина</th>
              <th className="px-5 py-3 font-medium">Статус</th>
              <th className="px-5 py-3 font-medium">Создан</th>
              <th className="px-5 py-3 font-medium text-right">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {curators.map((c) => (
              <tr
                key={c.id}
                className="cursor-pointer hover:bg-muted/30"
                onClick={() => setSelected(c)}
              >
                <td className="px-5 py-3">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground">{c.email}</div>
                  {c.username ? (
                    <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                      @{c.username}
                    </div>
                  ) : null}
                </td>
                <td className="px-5 py-3" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="group flex flex-wrap items-center gap-1.5"
                    onClick={() => setEditingCities(c)}
                    title="Изменить города менеджера по кадрам"
                  >
                    {(citiesById?.[c.id]?.length
                      ? citiesById[c.id]
                      : c.city
                        ? [c.city]
                        : []
                    ).map((city) => (
                      <CityPill key={city} city={city} />
                    ))}
                    <Pencil className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    <span className="sr-only">Изменить города</span>
                  </button>
                </td>
                <td className="px-5 py-3">
                  <DisciplinePill d={discipline?.[c.id]} h={history?.[c.id]} />
                </td>
                <td className="px-5 py-3">
                  <StatusPill status={c.status} />
                </td>
                <td className="px-5 py-3 text-muted-foreground">
                  {formatDate(c.createdAt)}
                </td>
                <td
                  className="px-5 py-3 text-right"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ManagerActions manager={c} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="flex flex-col gap-3 md:hidden">
        {curators.map((c) => (
          <Card
            key={c.id}
            className="cursor-pointer p-4"
            onClick={() => setSelected(c)}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{c.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {c.email}
                </p>
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                <ManagerActions manager={c} />
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusPill status={c.status} />
                {(citiesById?.[c.id]?.length
                  ? citiesById[c.id]
                  : c.city
                    ? [c.city]
                    : []
                ).map((city) => (
                  <CityPill key={city} city={city} />
                ))}
                <DisciplinePill d={discipline?.[c.id]} h={history?.[c.id]} />
              </div>
              <span className="text-xs text-muted-foreground">
                {formatDate(c.createdAt)}
              </span>
            </div>
          </Card>
        ))}
      </div>

      {selected ? (
        <CuratorLeadsDialog
          curator={selected}
          open={!!selected}
          onOpenChange={(o) => {
            if (!o) setSelected(null)
          }}
        />
      ) : null}

      {editingCities ? (
        <EditCuratorCitiesDialog
          curator={editingCities}
          open={!!editingCities}
          onOpenChange={(o) => {
            if (!o) setEditingCities(null)
          }}
        />
      ) : null}
    </>
  )
}
