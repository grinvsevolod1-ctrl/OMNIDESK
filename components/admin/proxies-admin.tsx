'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  Layers,
  Loader2,
  Plus,
  Server,
  ShieldCheck,
  TriangleAlert,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  assignProxyAction,
  checkProxyAction,
  createProxyAction,
  deleteProxyAction,
} from '@/app/actions/proxies'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import type {
  Manager,
  ManagerProxySummary,
  Proxy,
  ProxyAnalytics,
  ProxyKind,
} from '@/lib/types'
import {
  UNASSIGNED,
  type AssignFilter,
  type OwnerFilter,
  type SortMode,
  type StatusFilter,
} from '@/components/admin/proxies-shared'
import {
  AllProxiesView,
  ByManagerView,
} from '@/components/admin/proxies-views'

type ViewMode = 'all' | 'byManager'

export function ProxiesAdmin({
  proxies,
  managers,
  analytics,
  managerSummaries,
}: {
  proxies: Proxy[]
  managers: Manager[]
  analytics: ProxyAnalytics
  managerSummaries: ManagerProxySummary[]
}) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<ProxyKind>('socks5')
  const [assignTo, setAssignTo] = useState<string>(UNASSIGNED)
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)

  // View + filter state.
  const [view, setView] = useState<ViewMode>('all')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('all')
  const [assignFilter, setAssignFilter] = useState<AssignFilter>('all')
  const [sortMode, setSortMode] = useState<SortMode>('recent')

  function submit(formData: FormData) {
    formData.set('kind', kind)
    if (assignTo !== UNASSIGNED) formData.set('managerId', assignTo)
    startTransition(async () => {
      const res = await createProxyAction(formData)
      if (res.ok) {
        toast.success(res.message)
        setOpen(false)
        setKind('socks5')
        setAssignTo(UNASSIGNED)
      } else {
        toast.error(res.message)
      }
    })
  }

  function reassign(id: string, value: string) {
    setBusyId(id)
    startTransition(async () => {
      const res = await assignProxyAction(id, value === UNASSIGNED ? null : value)
      if (res.ok) {
        toast.success(res.message)
      } else {
        toast.error(res.message)
      }
      setBusyId(null)
    })
  }

  function check(id: string) {
    setBusyId(id)
    startTransition(async () => {
      const res = await checkProxyAction(id)
      if (res.ok) {
        toast.success(res.message)
      } else {
        toast.error(res.message)
      }
      setBusyId(null)
    })
  }

  function remove(id: string) {
    setBusyId(id)
    startTransition(async () => {
      const res = await deleteProxyAction(id)
      if (res.ok) {
        toast.success(res.message)
      } else {
        toast.error(res.message)
      }
      setBusyId(null)
    })
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = proxies.filter((p) => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false
      if (ownerFilter !== 'all' && p.createdByRole !== ownerFilter) return false
      if (assignFilter === 'assigned' && !p.managerId) return false
      if (assignFilter === 'unassigned' && p.managerId) return false
      if (!q) return true
      return (
        p.label.toLowerCase().includes(q) ||
        p.host.toLowerCase().includes(q) ||
        p.kind.toLowerCase().includes(q) ||
        (p.assignedManagerName ?? '').toLowerCase().includes(q)
      )
    })
    const statusRank: Record<Proxy['status'], number> = {
      error: 0,
      unknown: 1,
      ok: 2,
    }
    return [...list].sort((a, b) => {
      switch (sortMode) {
        case 'label':
          return a.label.localeCompare(b.label) || a.id.localeCompare(b.id)
        case 'status':
          return (
            statusRank[a.status] - statusRank[b.status] ||
            a.id.localeCompare(b.id)
          )
        case 'manager':
          return (
            (a.assignedManagerName ?? '~').localeCompare(
              b.assignedManagerName ?? '~',
            ) || a.id.localeCompare(b.id)
          )
        case 'recent':
        default:
          return (
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
            a.id.localeCompare(b.id)
          )
      }
    })
  }, [proxies, search, statusFilter, ownerFilter, assignFilter, sortMode])

  return (
    <div className="flex flex-col gap-6">
      {/* Analytics cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={Server}
          label="Всего прокси"
          value={analytics.total}
          hint={`${analytics.adminOwned} админ · ${analytics.managerOwned} менеджеры`}
        />
        <StatCard
          icon={ShieldCheck}
          label="Работают"
          value={analytics.ok}
          tone="success"
          hint={`${analytics.unknown} не проверено`}
        />
        <StatCard
          icon={TriangleAlert}
          label="С ошибкой"
          value={analytics.error}
          tone={analytics.error > 0 ? 'error' : 'default'}
          hint={analytics.error > 0 ? 'Требуют внимания' : 'Проблем нет'}
        />
        <StatCard
          icon={Users}
          label="Назначено"
          value={analytics.assigned}
          hint={`${analytics.unassigned} в пуле · ${analytics.channelsRouted} каналов`}
        />
      </div>

      {/* Toolbar: view switch + add */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex rounded-lg border border-border p-0.5">
          <ViewTab
            active={view === 'all'}
            onClick={() => setView('all')}
            icon={Layers}
            label="Все прокси"
          />
          <ViewTab
            active={view === 'byManager'}
            onClick={() => setView('byManager')}
            icon={Users}
            label="По менеджерам"
          />
        </div>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger
            render={
              <Button>
                <Plus className="size-4" />
                Добавить прокси
              </Button>
            }
          />
          <DialogContent className="sm:max-w-md">
            <form action={submit}>
              <DialogHeader>
                <DialogTitle>Добавить прокси</DialogTitle>
                <DialogDescription>
                  Добавьте сервер в пул и при желании сразу назначьте менеджеру.
                  Учётные данные шифруются.
                </DialogDescription>
              </DialogHeader>
              <div className="my-4 flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="px-label">Название</Label>
                  <Input
                    id="px-label"
                    name="label"
                    placeholder="Европа, резидентский"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-2">
                    <Label>Тип</Label>
                    <Select
                      value={kind}
                      onValueChange={(v) => setKind(v as ProxyKind)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="socks5">SOCKS5</SelectItem>
                        <SelectItem value="http">HTTP</SelectItem>
                        <SelectItem value="mtproto">MTProto</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label>Назначить</Label>
                    <Select
                      value={assignTo}
                      onValueChange={(v) => setAssignTo(v ?? UNASSIGNED)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={UNASSIGNED}>В пул (без назначения)</SelectItem>
                        {managers.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="flex flex-col gap-2 sm:col-span-2">
                    <Label htmlFor="px-host">Хост</Label>
                    <Input id="px-host" name="host" placeholder="1.2.3.4" required />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="px-port">Порт</Label>
                    <Input
                      id="px-port"
                      name="port"
                      type="number"
                      placeholder="1080"
                      required
                    />
                  </div>
                </div>
                {kind === 'mtproto' ? (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="px-secret">Секрет</Label>
                    <Input
                      id="px-secret"
                      name="secret"
                      placeholder="ee..."
                      className="font-mono text-sm"
                      required
                    />
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="px-user">Логин</Label>
                      <Input id="px-user" name="username" placeholder="необязательно" />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="px-pass">Пароль</Label>
                      <Input
                        id="px-pass"
                        name="password"
                        type="password"
                        placeholder="необязательно"
                      />
                    </div>
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOpen(false)}
                >
                  Отмена
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Добавить
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {view === 'all' ? (
        <AllProxiesView
          proxies={filtered}
          total={proxies.length}
          managers={managers}
          search={search}
          setSearch={setSearch}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          ownerFilter={ownerFilter}
          setOwnerFilter={setOwnerFilter}
          assignFilter={assignFilter}
          setAssignFilter={setAssignFilter}
          sortMode={sortMode}
          setSortMode={setSortMode}
          busyId={busyId}
          pending={pending}
          onReassign={reassign}
          onCheck={check}
          onRemove={remove}
        />
      ) : (
        <ByManagerView summaries={managerSummaries} />
      )}
    </div>
  )
}

/* ------------------------------- Parts ------------------------------- */

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'default',
}: {
  icon: typeof Server
  label: string
  value: number
  hint?: string
  tone?: 'default' | 'success' | 'error'
}) {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'error'
        ? 'text-destructive'
        : 'text-foreground'
  return (
    <Card className="flex flex-col gap-1 p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <p className={cn('text-2xl font-semibold tabular-nums', toneClass)}>
        {value}
      </p>
      {hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </Card>
  )
}

function ViewTab({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: typeof Server
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'bg-foreground text-background'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="size-4" />
      {label}
    </button>
  )
}
