'use client'

/**
 * Изменение состава команды: два чекбокс-списка (кураторы и менеджеры продаж).
 * Выбор доступен из уже состоящих в этой команде + свободных (unassigned).
 * Занятые другой командой люди здесь НЕ показываются:
 *   - руководитель их всё равно назначить не может (экшен отфильтрует);
 *   - админ переносит людей осознанно — для этого проще снять их из чужой
 *     команды на её карточке, чем тихо «красть» отсюда.
 * Паттерн чекбокса повторяет edit-head-members-dialog.
 */
import { useMemo, useState, useTransition } from 'react'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import { setTeamMembersAction } from '@/app/actions/teams'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Manager } from '@/lib/types'
import type { Team, TeamMember } from '@/lib/data/teams'

interface PickOption {
  id: string
  name: string
  city: string | null
}

export function EditTeamMembersDialog({
  team,
  isAdmin,
  unassigned,
  open,
  onOpenChange,
  onSaved,
}: {
  team: Team
  isAdmin: boolean
  unassigned: { curators: Manager[]; managers: Manager[] }
  open: boolean
  onOpenChange: (o: boolean) => void
  onSaved: () => void
}) {
  const [curatorSel, setCuratorSel] = useState<Set<string>>(
    () => new Set(team.curators.map((m) => m.id)),
  )
  const [managerSel, setManagerSel] = useState<Set<string>>(
    () => new Set(team.managers.map((m) => m.id)),
  )
  const [pending, startTransition] = useTransition()

  // Кандидаты = текущий состав команды + свободные того же вида.
  const curatorOptions = useMemo(
    () => mergeOptions(team.curators, unassigned.curators),
    [team.curators, unassigned.curators],
  )
  const managerOptions = useMemo(
    () => mergeOptions(team.managers, unassigned.managers),
    [team.managers, unassigned.managers],
  )

  function toggle(set: (fn: (prev: Set<string>) => Set<string>) => void, id: string) {
    set((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function save() {
    startTransition(async () => {
      const res = await setTeamMembersAction({
        teamId: team.id,
        curatorIds: [...curatorSel],
        managerIds: [...managerSel],
      })
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Состав команды «{team.name}»</DialogTitle>
          <DialogDescription>
            {isAdmin
              ? 'Отметьте кураторов и менеджеров продаж. Доступны свободные и уже состоящие в команде.'
              : 'Отметьте доступных вам сотрудников (свободных или уже в ваших командах).'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
          <PickerSection
            title="Менеджеры по кадрам"
            options={curatorOptions}
            selected={curatorSel}
            onToggle={(id) => toggle(setCuratorSel, id)}
          />
          <PickerSection
            title="Менеджеры продаж"
            options={managerOptions}
            selected={managerSel}
            onToggle={(id) => toggle(setManagerSel, id)}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Отмена
          </Button>
          <Button size="sm" onClick={save} disabled={pending}>
            {pending ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PickerSection({
  title,
  options,
  selected,
  onToggle,
}: {
  title: string
  options: PickOption[]
  selected: Set<string>
  onToggle: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="px-2 text-xs font-medium text-muted-foreground">
        {title}
      </span>
      {options.length === 0 ? (
        <p className="px-2 py-2 text-sm text-muted-foreground/70">
          Нет доступных сотрудников.
        </p>
      ) : (
        options.map((m) => (
          <label
            key={m.id}
            className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50"
          >
            <input
              type="checkbox"
              className="peer sr-only"
              checked={selected.has(m.id)}
              onChange={() => onToggle(m.id)}
            />
            <span
              aria-hidden="true"
              className="flex size-4 shrink-0 items-center justify-center rounded border border-input bg-background text-primary-foreground transition-colors peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring"
            >
              {selected.has(m.id) ? <Check className="size-3" /> : null}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm">{m.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {m.city ?? 'Без города'}
              </span>
            </span>
          </label>
        ))
      )}
    </div>
  )
}

/** Текущий состав + свободные, без дублей, отсортировано по имени. */
function mergeOptions(
  current: TeamMember[],
  free: Manager[],
): PickOption[] {
  const map = new Map<string, PickOption>()
  for (const m of current) map.set(m.id, { id: m.id, name: m.name, city: m.city })
  for (const m of free) {
    if (!map.has(m.id)) map.set(m.id, { id: m.id, name: m.name, city: m.city })
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
}
