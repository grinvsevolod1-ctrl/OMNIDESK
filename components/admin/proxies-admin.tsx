'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  Globe,
  Layers,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  User,
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

const UNASSIGNED = 'unassigned'

const STATUS_COLOR: Record<Proxy['status'], string> = {
  ok: 'bg-success',
  error: 'bg-destructive',
  unknown: 'bg-muted-foreground',
}

const STATUS_LABEL: Record<Proxy['status'], string> = {
  ok: 'Работает',
  error: 'Не работает',
  unknown: 'Не проверен',
}

type ViewMode = 'all' | 'byManager'
type StatusFilter = 'all' | Proxy['status']
type OwnerFilter = 'all' | 'admin' | 'manager'
type AssignFilter = 'all' | 'assigned' | 'unassigned'
type SortMode = 'recent' | 'label' | 'status' | 'manager'

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
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2 flex flex-col gap-2">
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

function AllProxiesView({
  proxies,
  total,
  managers,
  search,
  setSearch,
  statusFilter,
  setStatusFilter,
  ownerFilter,
  setOwnerFilter,
  assignFilter,
  setAssignFilter,
  sortMode,
  setSortMode,
  busyId,
  pending,
  onReassign,
  onCheck,
  onRemove,
}: {
  proxies: Proxy[]
  total: number
  managers: Manager[]
  search: string
  setSearch: (v: string) => void
  statusFilter: StatusFilter
  setStatusFilter: (v: StatusFilter) => void
  ownerFilter: OwnerFilter
  setOwnerFilter: (v: OwnerFilter) => void
  assignFilter: AssignFilter
  setAssignFilter: (v: AssignFilter) => void
  sortMode: SortMode
  setSortMode: (v: SortMode) => void
  busyId: string | null
  pending: boolean
  onReassign: (id: string, value: string) => void
  onCheck: (id: string) => void
  onRemove: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по названию, хосту, менеджеру…"
            className="pl-8"
            aria-label="Поиск прокси"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter((v as StatusFilter) ?? 'all')}
          >
            <SelectTrigger aria-label="Статус">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все статусы</SelectItem>
              <SelectItem value="ok">Работают</SelectItem>
              <SelectItem value="error">С ошибкой</SelectItem>
              <SelectItem value="unknown">Не проверены</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={ownerFilter}
            onValueChange={(v) => setOwnerFilter((v as OwnerFilter) ?? 'all')}
          >
            <SelectTrigger aria-label="Владелец">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Любой владелец</SelectItem>
              <SelectItem value="admin">Создан админом</SelectItem>
              <SelectItem value="manager">Создан менеджером</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={assignFilter}
            onValueChange={(v) => setAssignFilter((v as AssignFilter) ?? 'all')}
          >
            <SelectTrigger aria-label="Назначение">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все</SelectItem>
              <SelectItem value="assigned">Назначенные</SelectItem>
              <SelectItem value="unassigned">В пуле</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={sortMode}
            onValueChange={(v) => setSortMode((v as SortMode) ?? 'recent')}
          >
            <SelectTrigger aria-label="Сортировка">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">Сначала новые</SelectItem>
              <SelectItem value="label">По названию</SelectItem>
              <SelectItem value="status">По статусу</SelectItem>
              <SelectItem value="manager">По менеджеру</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Показано {proxies.length} из {total}
      </p>

      {proxies.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          {total === 0
            ? 'Прокси пока нет. Добавьте сервер и назначьте его менеджеру.'
            : 'Ничего не найдено по выбранным фильтрам.'}
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {proxies.map((p) => {
            const busy = pending && busyId === p.id
            return (
              <Card key={p.id} className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                      <Globe className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                        {p.label}
                        {p.hasAuth ? (
                          <Lock className="size-3 text-muted-foreground" />
                        ) : null}
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {p.kind}://{p.host}:{p.port}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span
                      className={`size-1.5 rounded-full ${STATUS_COLOR[p.status]}`}
                      aria-hidden="true"
                    />
                    <span className="text-xs text-muted-foreground">
                      {STATUS_LABEL[p.status]}
                    </span>
                  </div>
                </div>

                {/* Ownership chip */}
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
                      p.createdByRole === 'manager'
                        ? 'border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-400'
                        : 'border-border bg-muted text-muted-foreground',
                    )}
                  >
                    {p.createdByRole === 'manager' ? (
                      <>
                        <User className="size-2.5" />
                        Создан: {p.ownerManagerName ?? 'менеджер'}
                      </>
                    ) : (
                      <>
                        <ShieldCheck className="size-2.5" />
                        Создан админом
                      </>
                    )}
                  </span>
                </div>

                {p.lastError ? (
                  <p className="break-words rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                    {p.lastError}
                  </p>
                ) : null}

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Select
                    value={p.managerId ?? UNASSIGNED}
                    onValueChange={(v) => onReassign(p.id, v ?? UNASSIGNED)}
                    disabled={busy}
                  >
                    <SelectTrigger className="w-full sm:flex-1">
                      <SelectValue placeholder="Назначить менеджеру" />
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
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onCheck(p.id)}
                      disabled={busy}
                    >
                      {busy ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <RefreshCw className="size-4" />
                      )}
                      Тест
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Удалить ${p.label}`}
                      onClick={() => onRemove(p.id)}
                      disabled={busy}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ByManagerView({ summaries }: { summaries: ManagerProxySummary[] }) {
  if (summaries.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
        Менеджеров пока нет.
      </p>
    )
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {summaries.map((s) => (
        <Card key={s.manager.id} className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40 text-xs font-medium">
                {s.manager.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{s.manager.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {s.manager.email}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end">
              <span className="text-lg font-semibold tabular-nums">{s.total}</span>
              <span className="text-[10px] text-muted-foreground">прокси</span>
            </div>
          </div>

          {/* Status bar */}
          {s.total > 0 ? (
            <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
              <span
                className="bg-success"
                style={{ width: `${(s.ok / s.total) * 100}%` }}
              />
              <span
                className="bg-destructive"
                style={{ width: `${(s.error / s.total) * 100}%` }}
              />
              <span
                className="bg-muted-foreground"
                style={{ width: `${(s.unknown / s.total) * 100}%` }}
              />
            </div>
          ) : (
            <div className="h-1.5 rounded-full bg-muted" />
          )}

          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <Metric label="Работают" value={s.ok} tone="success" />
            <Metric label="Ошибки" value={s.error} tone="error" />
            <Metric label="Свои" value={s.selfOwned} />
            <Metric label="Каналов" value={s.channelsRouted} />
          </div>

          <p className="text-[11px] text-muted-foreground">
            {s.adminAssigned} назначено админом · {s.selfOwned} создано
            менеджером
          </p>
        </Card>
      ))}
    </div>
  )
}

function Metric({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: number
  tone?: 'default' | 'success' | 'error'
}) {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'error'
        ? 'text-destructive'
        : 'text-foreground'
  return (
    <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5">
      <p className={cn('text-sm font-semibold tabular-nums', toneClass)}>
        {value}
      </p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  )
}
