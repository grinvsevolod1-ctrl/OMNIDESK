'use client'

/**
 * Админ-таблица руководителей: право доступа («просмотр» / «просмотр и
 * редактирование»), состав группы — кураторы (менеджеры по кадрам) и менеджеры
 * продаж, — общие действия аккаунта (блокировка, сброс пароля, удаление —
 * ManagerActions).
 */
import { useState, useTransition } from 'react'
import { Briefcase, Pencil, ShieldCheck, Users } from 'lucide-react'
import { setHeadCanEditAction } from '@/app/actions/admin-heads'
import { ManagerActions } from '@/components/admin/manager-actions'
import { EditHeadMembersDialog } from '@/components/admin/heads/edit-head-members-dialog'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import type { HeadCurator, HeadManager } from '@/lib/data/heads'
import { formatMskDate as formatDate } from '@/lib/time'
import type { Manager } from '@/lib/types'

export interface HeadGroup {
  head: Manager
  curators: HeadCurator[]
  managers: HeadManager[]
}

/** Строка справочника для назначения (куратор ИЛИ менеджер продаж). */
export interface AssignableMember {
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

/** Чипы состава группы одного вида (кураторы или менеджеры) + кнопка правки. */
function MemberChips({
  members,
  icon,
  emptyText,
  onEdit,
}: {
  members: { id: string; name: string; city?: string | null; activeLeads: number }[]
  icon: 'curator' | 'manager'
  emptyText: string
  onEdit: () => void
}) {
  const Icon = icon === 'curator' ? Users : Briefcase
  return (
    <div className="flex max-w-md flex-wrap items-center gap-1.5">
      {members.length === 0 ? (
        <span className="text-xs text-muted-foreground">{emptyText}</span>
      ) : (
        members.map((m) => (
          <Badge
            key={m.id}
            variant="outline"
            className="gap-1.5 border-transparent bg-muted text-muted-foreground"
            title={`${m.name}${m.city ? ` · ${m.city}` : ''} · активных лидов: ${m.activeLeads}`}
          >
            <Icon className="size-3" />
            {m.name}
            <span className="font-mono">{m.activeLeads}</span>
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
        title="Изменить состав"
        aria-label="Изменить состав"
      >
        <Pencil className="size-3" />
      </button>
    </div>
  )
}

export function HeadsTable({
  groups,
  allCurators,
  allManagers,
}: {
  groups: HeadGroup[]
  allCurators: AssignableMember[]
  allManagers: AssignableMember[]
}) {
  // Какую группу и какой её вид сейчас редактируем.
  const [editing, setEditing] = useState<{
    group: HeadGroup
    kind: 'curator' | 'manager'
  } | null>(null)

  return (
    <>
      <Card className="hidden overflow-hidden lg:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-3 font-medium">Имя</th>
              <th className="px-5 py-3 font-medium">Доступ</th>
              <th className="px-5 py-3 font-medium">Менеджеры по кадрам</th>
              <th className="px-5 py-3 font-medium">Менеджеры продаж</th>
              <th className="px-5 py-3 font-medium">Статус</th>
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
                  <MemberChips
                    members={g.curators}
                    icon="curator"
                    emptyText="Нет кураторов"
                    onEdit={() => setEditing({ group: g, kind: 'curator' })}
                  />
                </td>
                <td className="px-5 py-3">
                  <MemberChips
                    members={g.managers}
                    icon="manager"
                    emptyText="Нет менеджеров"
                    onEdit={() => setEditing({ group: g, kind: 'manager' })}
                  />
                </td>
                <td className="px-5 py-3">
                  <StatusPill status={g.head.status} />
                </td>
                <td className="px-5 py-3 text-right">
                  <ManagerActions manager={g.head} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="flex flex-col gap-3 lg:hidden">
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
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Менеджеры по кадрам
                </span>
                <MemberChips
                  members={g.curators}
                  icon="curator"
                  emptyText="Нет кураторов"
                  onEdit={() => setEditing({ group: g, kind: 'curator' })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Менеджеры продаж
                </span>
                <MemberChips
                  members={g.managers}
                  icon="manager"
                  emptyText="Нет менеджеров"
                  onEdit={() => setEditing({ group: g, kind: 'manager' })}
                />
              </div>
              <span className="text-xs text-muted-foreground">
                {formatDate(g.head.createdAt)}
              </span>
            </div>
          </Card>
        ))}
      </div>

      {editing ? (
        <EditHeadMembersDialog
          kind={editing.kind}
          group={editing.group}
          allMembers={editing.kind === 'curator' ? allCurators : allManagers}
          open={!!editing}
          onOpenChange={(o) => {
            if (!o) setEditing(null)
          }}
        />
      ) : null}
    </>
  )
}
