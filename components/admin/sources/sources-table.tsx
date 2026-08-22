'use client'

/**
 * Админ-список источников трафика: байер, окно дня/«долётов», менеджеры,
 * счётчики лидов, правка и удаление.
 */
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Briefcase,
  Megaphone,
  MoreHorizontal,
  Pencil,
  Radio,
  Trash2,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { deleteSourceAction } from '@/app/actions/admin-sources'
import {
  SourceDialog,
  type BuyerOption,
} from '@/components/admin/sources/source-dialog'
import {
  EditSourceManagersDialog,
  type AssignableManager,
} from '@/components/admin/sources/edit-source-managers-dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface SourceRow {
  id: string
  name: string
  buyerId: string | null
  buyerName: string | null
  dayStart: number
  dayEnd: number
  notes: string | null
  isActive: boolean
  leadCount: number
  managers: { id: string; name: string }[]
}

function hhmm(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0')
  const m = String(minutes % 60).padStart(2, '0')
  return `${h}:${m}`
}

export function SourcesTable({
  sources,
  buyers,
  allManagers,
}: {
  sources: SourceRow[]
  buyers: BuyerOption[]
  allManagers: AssignableManager[]
}) {
  const router = useRouter()
  const [editing, setEditing] = useState<SourceRow | null>(null)
  const [editingManagers, setEditingManagers] = useState<SourceRow | null>(
    null,
  )
  const [deleting, setDeleting] = useState<SourceRow | null>(null)
  const [pending, startTransition] = useTransition()

  function confirmDelete() {
    if (!deleting) return
    const source = deleting
    startTransition(async () => {
      const res = await deleteSourceAction(source.id)
      if (res.ok) {
        toast.success(res.message)
        setDeleting(null)
        router.refresh()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {sources.map((s) => (
          <Card key={s.id} className="flex flex-col gap-3 p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Radio className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{s.name}</span>
                {!s.isActive ? (
                  <Badge
                    variant="outline"
                    className="border-transparent bg-muted text-muted-foreground"
                  >
                    Выключен
                  </Badge>
                ) : null}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      aria-label="Действия с источником"
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setEditing(s)}>
                    <Pencil className="size-4" />
                    Настройки
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setEditingManagers(s)}>
                    <Briefcase className="size-4" />
                    Менеджеры
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setDeleting(s)}
                  >
                    <Trash2 className="size-4" />
                    Удалить
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="flex flex-col gap-1.5 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Megaphone className="size-3.5 shrink-0" />
                {s.buyerName ?? 'Без байера'}
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="text-xs">
                  День {hhmm(s.dayStart)}–{hhmm(s.dayEnd)} · долёты{' '}
                  {hhmm(s.dayEnd)}–{hhmm(s.dayStart)}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {s.managers.length === 0 ? (
                <button
                  type="button"
                  onClick={() => setEditingManagers(s)}
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Подключить менеджеров
                </button>
              ) : (
                s.managers.map((m) => (
                  <Badge
                    key={m.id}
                    variant="outline"
                    className="gap-1.5 border-transparent bg-muted text-muted-foreground"
                  >
                    <Briefcase className="size-3" />
                    {m.name}
                  </Badge>
                ))
              )}
            </div>

            <div className="mt-auto flex items-center gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Users className="size-3.5" />
                лидов: <span className="font-mono">{s.leadCount}</span>
              </span>
              {s.notes ? (
                <span className="min-w-0 truncate" title={s.notes}>
                  {s.notes}
                </span>
              ) : null}
            </div>
          </Card>
        ))}
      </div>

      {editing ? (
        <SourceDialog
          buyers={buyers}
          source={editing}
          open={!!editing}
          onOpenChange={(o) => {
            if (!o) setEditing(null)
          }}
        />
      ) : null}

      {editingManagers ? (
        <EditSourceManagersDialog
          sourceId={editingManagers.id}
          sourceName={editingManagers.name}
          currentManagerIds={editingManagers.managers.map((m) => m.id)}
          allManagers={allManagers}
          open={!!editingManagers}
          onOpenChange={(o) => {
            if (!o) setEditingManagers(null)
          }}
        />
      ) : null}

      <AlertDialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o) setDeleting(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить источник?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `Источник «${deleting.name}» будет удалён. Менеджеры отвяжутся, атрибуция его лидов обнулится. Сами лиды и диалоги не пострадают.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} disabled={pending}>
              {pending ? 'Удаляем…' : 'Удалить'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
