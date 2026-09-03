'use client'

/**
 * Единый экран управления командами (миграция 150) — используется и админом
 * (/admin/teams: все команды + выбор владельца-руководителя), и руководителем
 * (/head/team: только его команды). Роль различается по `viewerRole` из
 * listTeamsAction; сами права проверяются в экшенах на сервере.
 *
 * Переиспользует общие блоки (PageHeader/EmptyState/Card/Badge) и паттерн
 * чекбокс-пикера состава из edit-head-members-dialog.
 */
import { useState, useTransition } from 'react'
import useSWR from 'swr'
import { Plus, Trash2, Users, UserCog, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import {
  createTeamAction,
  deleteTeamAction,
  listTeamsAction,
  renameTeamAction,
} from '@/app/actions/teams'
import { EditTeamMembersDialog } from '@/components/teams/edit-team-members-dialog'
import { EmptyState, PageHeader } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { Team } from '@/lib/data/teams'

type LoaderData = Awaited<ReturnType<typeof listTeamsAction>>

export function TeamsManager({ initial }: { initial: LoaderData }) {
  const { data, mutate } = useSWR('teams-manager', () => listTeamsAction(), {
    fallbackData: initial,
    revalidateOnFocus: false,
  })
  const view = data ?? initial
  const isAdmin = view.viewerRole === 'admin'

  const refresh = () => void mutate()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={isAdmin ? 'Команды' : 'Моя команда'}
        description="Команда — это руководитель, его менеджеры по кадрам и менеджеры продаж. Переданный менеджером лид попадает в пул команды и разбирается кураторами вручную."
        action={
          <CreateTeamDialog
            heads={view.heads}
            isAdmin={isAdmin}
            onCreated={refresh}
          />
        }
      />

      {view.teams.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Команд пока нет"
          description={
            isAdmin
              ? 'Создайте команду, назначьте владельца-руководителя и добавьте кураторов и менеджеров.'
              : 'Создайте команду и добавьте в неё доступных вам кураторов и менеджеров.'
          }
          action={
            <CreateTeamDialog
              heads={view.heads}
              isAdmin={isAdmin}
              onCreated={refresh}
            />
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {view.teams.map((team) => (
            <TeamCard
              key={team.id}
              team={team}
              stats={view.stats[team.id]}
              isAdmin={isAdmin}
              unassigned={view.unassigned}
              onChanged={refresh}
            />
          ))}
        </div>
      )}

      {/* Секция «Без команды» — заметная, чтобы админ/руководитель никого не
          потерял при миграции: у этих людей передача лидов не работает. */}
      <UnassignedSection unassigned={view.unassigned} />
    </div>
  )
}

function TeamCard({
  team,
  stats,
  isAdmin,
  unassigned,
  onChanged,
}: {
  team: Team
  stats: LoaderData['stats'][string] | undefined
  isAdmin: boolean
  unassigned: LoaderData['unassigned']
  onChanged: () => void
}) {
  const [editOpen, setEditOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const memberCount = team.curators.length + team.managers.length

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="truncate font-semibold">{team.name}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {team.headName ? `Руководитель: ${team.headName}` : 'Без руководителя'}
            {' · '}
            {memberCount} чел.
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Переименовать"
            onClick={() => setRenameOpen(true)}
          >
            <Pencil className="size-4" />
          </Button>
          <DeleteTeamButton team={team} onDeleted={onChanged} />
        </div>
      </div>

      <TeamStatsRow stats={stats} />

      <div className="flex flex-col gap-3">
        <MemberList
          icon={Users}
          label="Менеджеры по кадрам"
          members={team.curators}
          emptyText="Нет кураторов"
        />
        <MemberList
          icon={UserCog}
          label="Менеджеры продаж"
          members={team.managers}
          emptyText="Нет менеджеров продаж"
        />
      </div>

      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setEditOpen(true)}
      >
        <UserCog className="size-4" />
        Изменить состав
      </Button>

      <EditTeamMembersDialog
        team={team}
        isAdmin={isAdmin}
        unassigned={unassigned}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={onChanged}
      />
      <RenameTeamDialog
        team={team}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        onSaved={onChanged}
      />
    </Card>
  )
}

/**
 * Сводка команды: пул (не разобрано) выделяем — это метрика, за которой следит
 * и админ, и руководитель. Всё считается по team_id, поэтому админ видит те же
 * срезы, что и руководитель на своём обзоре (паритет).
 */
function TeamStatsRow({
  stats,
}: {
  stats: LoaderData['stats'][string] | undefined
}) {
  const s = stats ?? { pool: 0, claimed: 0, refused: 0, left: 0, total: 0 }
  const items: { label: string; value: number; tone?: string }[] = [
    { label: 'В пуле', value: s.pool, tone: s.pool > 0 ? 'text-warning' : undefined },
    { label: 'В работе', value: s.claimed },
    { label: 'Отказ', value: s.refused },
    { label: 'Слив', value: s.left },
    { label: 'Всего', value: s.total },
  ]
  return (
    <div className="grid grid-cols-5 gap-1 rounded-lg border border-border bg-muted/30 p-2 text-center">
      {items.map((it) => (
        <div key={it.label} className="flex flex-col">
          <span
            className={cn(
              'text-base font-semibold tabular-nums',
              it.tone ?? 'text-foreground',
            )}
          >
            {it.value}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {it.label}
          </span>
        </div>
      ))}
    </div>
  )
}

function MemberList({
  icon: Icon,
  label,
  members,
  emptyText,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  members: Team['curators']
  emptyText: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </span>
      {members.length === 0 ? (
        <span className="text-xs text-muted-foreground/70">{emptyText}</span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {members.map((m) => (
            <Badge
              key={m.id}
              variant="outline"
              className="gap-1 border-transparent bg-muted font-normal text-foreground"
            >
              {m.name}
              <span className="text-muted-foreground">· {m.activeLeads}</span>
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

function UnassignedSection({
  unassigned,
}: {
  unassigned: LoaderData['unassigned']
}) {
  const total = unassigned.curators.length + unassigned.managers.length
  if (total === 0) return null

  return (
    <Card className="flex flex-col gap-3 border-warning/40 bg-warning/5 p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 font-semibold">
          <Users className="size-4 text-warning" />
          Без команды ({total})
        </h3>
        <p className="text-sm text-muted-foreground">
          Эти сотрудники не состоят ни в одной команде. Менеджеры продаж без
          команды не могут передавать лидов, а кураторы без команды не получают
          лиды из пула — добавьте их в команду.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {unassigned.curators.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Кураторы:
            </span>
            {unassigned.curators.map((m) => (
              <Badge key={m.id} variant="outline" className="font-normal">
                {m.name}
              </Badge>
            ))}
          </div>
        ) : null}
        {unassigned.managers.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Менеджеры продаж:
            </span>
            {unassigned.managers.map((m) => (
              <Badge key={m.id} variant="outline" className="font-normal">
                {m.name}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  )
}

function CreateTeamDialog({
  heads,
  isAdmin,
  onCreated,
}: {
  heads: LoaderData['heads']
  isAdmin: boolean
  onCreated: () => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [headId, setHeadId] = useState<string>('')
  const [pending, startTransition] = useTransition()

  function create() {
    startTransition(async () => {
      const res = await createTeamAction({
        name,
        headId: isAdmin ? headId || null : undefined,
      })
      if (res.ok) {
        toast.success(res.message)
        setOpen(false)
        setName('')
        setHeadId('')
        onCreated()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button className="gap-1.5" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        Создать команду
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Новая команда</DialogTitle>
          <DialogDescription>
            Дайте команде название{isAdmin ? ' и выберите руководителя' : ''}.
            Состав добавите на следующем шаге.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="team-name">Название</Label>
            <Input
              id="team-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Например, «Москва — курьеры»"
            />
          </div>
          {isAdmin ? (
            <div className="flex flex-col gap-1.5">
              <Label>Руководитель</Label>
              <Select
                value={headId}
                onValueChange={(v) => setHeadId(v ?? '')}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Без руководителя" />
                </SelectTrigger>
                <SelectContent>
                  {heads.map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="outline" size="sm">
                Отмена
              </Button>
            }
          />
          <Button
            size="sm"
            disabled={pending || name.trim().length < 2}
            onClick={create}
          >
            Создать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RenameTeamDialog({
  team,
  open,
  onOpenChange,
  onSaved,
}: {
  team: Team
  open: boolean
  onOpenChange: (o: boolean) => void
  onSaved: () => void
}) {
  const [name, setName] = useState(team.name)
  const [pending, startTransition] = useTransition()

  function save() {
    startTransition(async () => {
      const res = await renameTeamAction({ teamId: team.id, name })
      if (res.ok) {
        toast.success(res.message)
        onOpenChange(false)
        onSaved()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Переименовать команду</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button
            size="sm"
            disabled={pending || name.trim().length < 2}
            onClick={save}
          >
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteTeamButton({
  team,
  onDeleted,
}: {
  team: Team
  onDeleted: () => void
}) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  function remove() {
    startTransition(async () => {
      const res = await deleteTeamAction({ teamId: team.id })
      if (res.ok) {
        toast.success(res.message)
        setOpen(false)
        onDeleted()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Удалить команду"
        className="text-muted-foreground hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Удалить команду «{team.name}»?</DialogTitle>
            <DialogDescription>
              Участники станут «без команды» (аккаунты не удаляются). Уже
              закреплённые за кураторами лиды останутся у них.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={remove}
            >
              Удалить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
