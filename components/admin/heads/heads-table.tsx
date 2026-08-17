'use client'

/**
 * Админ-таблица руководителей: право доступа («просмотр» / «просмотр и
 * редактирование»), состав группы кураторов, общие действия аккаунта
 * (блокировка, сброс пароля, удаление — ManagerActions).
 */
import { useState, useTransition } from 'react'
import { Pencil, ShieldCheck, Users } from 'lucide-react'
import { setHeadCanEditAction } from '@/app/actions/admin-heads'
import { ManagerActions } from '@/components/admin/manager-actions'
import { EditHeadCuratorsDialog } from '@/components/admin/heads/edit-head-curators-dialog'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import type { HeadCurator } from '@/lib/data/heads'
import { formatMskDate as formatDate } from '@/lib/time'
import type { Manager } from '@/lib/types'

export interface HeadGroup {
  head: Manager
  curators: HeadCurator[]
}

export interface AssignableCurator {
  id: string
  name: string
  city: string | null
  headId: string | null
  headName: string | null
}

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

function PermissionToggle({ head }: { head: Manager }) {
  const [pending, startTransition] = useTransition()
  const [canEdit, setCanEdit] = useState(head.headCanEdit)

  return (
    <div className="flex items-center gap-2">
      <Switch
        checked={canEdit}
        disabled={pending}
        onCheckedChange={(next) => {
          // Optimistic toggle; при ошибке откатываем.
          setCanEdit(next)
          startTransition(async () => {
            const res = await setHeadCanEditAction(head.id, next)
            if (!res.ok) {
              setCanEdit(!next)
              toast.error(res.message)
            } else {
              toast.success(res.message)
            }
          })
        }}
        aria-label="Право редактирования"
      />
      <span className="text-xs text-muted-foreground">
        {canEdit ? 'Просмотр и редактирование' : 'Только просмотр'}
      </span>
    </div>
  )
}

function CuratorChips({
  group,
  onEdit,
}: {
  group: HeadGroup
  onEdit: () => void
}) {
  return (
    <div className="flex max-w-md flex-wrap items-center gap-1.5">
      {group.curators.length === 0 ? (
        <span className="text-xs text-muted-foreground">Нет кураторов</span>
      ) : (
        group.curators.map((c) => (
          <Badge
            key={c.id}
            variant="outline"
            className="gap-1.5 border-transparent bg-muted text-muted-foreground"
            title={`${c.name}${c.city ? ` · ${c.city}` : ''} · активных лидов: ${c.activeLeads}`}
          >
            <Users className="size-3" />
            {c.name}
            <span className="font-mono">{c.activeLeads}</span>
          </Badge>
        ))
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onEdit()
        }}
        className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title="Изменить состав группы"
        aria-label="Изменить состав группы"
      >
        <Pencil className="size-3" />
      </button>
    </div>
  )
}

export function HeadsTable({
  groups,
  allCurators,
}: {
  groups: HeadGroup[]
  allCurators: AssignableCurator[]
}) {
  const [editing, setEditing] = useState<HeadGroup | null>(null)

  return (
    <>
      <Card className="hidden overflow-hidden md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-3 font-medium">Имя</th>
              <th className="px-5 py-3 font-medium">Доступ</th>
              <th className="px-5 py-3 font-medium">Менеджеры по кадрам</th>
              <th className="px-5 py-3 font-medium">Статус</th>
              <th className="px-5 py-3 font-medium">Создан</th>
              <th className="px-5 py-3 font-medium text-right">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {groups.map((g) => (
              <tr key={g.head.id} className="hover:bg-muted/30">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2 font-medium">
                    <ShieldCheck className="size-4 text-muted-foreground" />
                    {g.head.name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {g.head.email}
                  </div>
                  {g.head.username ? (
                    <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                      @{g.head.username}
                    </div>
                  ) : null}
                </td>
                <td className="px-5 py-3">
                  <PermissionToggle head={g.head} />
                </td>
                <td className="px-5 py-3">
                  <CuratorChips group={g} onEdit={() => setEditing(g)} />
                </td>
                <td className="px-5 py-3">
                  <StatusPill status={g.head.status} />
                </td>
                <td className="px-5 py-3 text-muted-foreground">
                  {formatDate(g.head.createdAt)}
                </td>
                <td className="px-5 py-3 text-right">
                  <ManagerActions manager={g.head} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="flex flex-col gap-3 md:hidden">
        {groups.map((g) => (
          <Card key={g.head.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{g.head.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {g.head.email}
                </p>
              </div>
              <ManagerActions manager={g.head} />
            </div>
            <div className="mt-3 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusPill status={g.head.status} />
              </div>
              <PermissionToggle head={g.head} />
              <CuratorChips group={g} onEdit={() => setEditing(g)} />
              <span className="text-xs text-muted-foreground">
                {formatDate(g.head.createdAt)}
              </span>
            </div>
          </Card>
        ))}
      </div>

      {editing ? (
        <EditHeadCuratorsDialog
          group={editing}
          allCurators={allCurators}
          open={!!editing}
          onOpenChange={(o) => {
            if (!o) setEditing(null)
          }}
        />
      ) : null}
    </>
  )
}
