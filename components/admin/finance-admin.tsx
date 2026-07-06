'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Archive,
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  CreditCard,
  FolderPlus,
  Layers,
  ListChecks,
  Loader2,
  MousePointerClick,
  Pencil,
  Plus,
  Target,
  Trash2,
  TrendingDown,
  Users,
  Wallet,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  addAdStatAction,
  addAdTopupAction,
  addTaskAction,
  createAdAccountAction,
  createEntryAction,
  createResourceAction,
  createSectionAction,
  deleteAdAccountAction,
  deleteAdStatAction,
  deleteAdTopupAction,
  deleteEntryAction,
  deleteResourceAction,
  deleteSectionAction,
  deleteTaskAction,
  renameSectionAction,
  toggleTaskAction,
  updateAdAccountAction,
  updateEntryAction,
  updateResourceAction,
  type FinanceResult,
} from '@/app/actions/finance'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { EmptyState, StatCard } from '@/components/page-parts'
import { cn } from '@/lib/utils'
import {
  AD_PLATFORMS,
  AD_STATUSES,
  FINANCE_CURRENCIES,
  FINANCE_ENTRY_STATUSES,
  type AdPlatform,
  type AdStatus,
  type FinanceAdAccount,
  type FinanceCurrency,
  type FinanceEntry,
  type FinanceEntryStatus,
  type FinanceResource,
  type FinanceSection,
} from '@/lib/finance-types'

/* ================================================================== */
/* Meta + formatters                                                   */
/* ================================================================== */

const STATUS_META: Record<
  FinanceEntryStatus,
  { label: string; className: string }
> = {
  planned: { label: 'Запланирован', className: 'bg-muted text-muted-foreground' },
  in_progress: { label: 'В работе', className: 'bg-warning/15 text-warning' },
  done: { label: 'Оплачен', className: 'bg-success/15 text-success' },
  cancelled: {
    label: 'Отменён',
    className: 'bg-destructive/10 text-destructive',
  },
}

const PLATFORM_META: Record<AdPlatform, string> = {
  yandex_direct: 'Яндекс Директ',
  google_ads: 'Google Ads',
  vk_ads: 'VK Реклама',
  telegram_ads: 'Telegram Ads',
  mytarget: 'myTarget',
  other: 'Другое',
}

const AD_STATUS_META: Record<
  AdStatus,
  { label: string; className: string; dot: string }
> = {
  active: {
    label: 'Активен',
    className: 'bg-success/15 text-success',
    dot: 'bg-success',
  },
  moderation: {
    label: 'На модерации',
    className: 'bg-warning/15 text-warning',
    dot: 'bg-warning',
  },
  stopped: {
    label: 'Остановлен',
    className: 'bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
  },
  no_funds: {
    label: 'Нет средств',
    className: 'bg-destructive/15 text-destructive',
    dot: 'bg-destructive',
  },
  banned: {
    label: 'Забанен',
    className: 'bg-destructive/15 text-destructive',
    dot: 'bg-destructive',
  },
  archived: {
    label: 'Архив',
    className: 'bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
  },
}

const CURRENCY_SYMBOL: Record<FinanceCurrency, string> = {
  USDT: '₮',
  RUB: '₽',
  USD: '$',
  EUR: '€',
}

function formatMoney(amount: number, currency: FinanceCurrency): string {
  const n = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount)
  return `${n} ${CURRENCY_SYMBOL[currency]}`
}

function formatInt(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(n)
}

function formatPct(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(n < 10 ? 2 : 1)}%`
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function formatDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d)
}

/* ================================================================== */
/* Aggregation                                                         */
/* ================================================================== */

interface AccountMetrics {
  topups: number
  spend: number
  balance: number
  impressions: number
  clicks: number
  leads: number
  ctr: number
  cr: number
  cpl: number
  cpc: number
}

function accountMetrics(a: FinanceAdAccount): AccountMetrics {
  const topups = a.topups.reduce((s, t) => s + t.amount, 0)
  let spend = 0
  let impressions = 0
  let clicks = 0
  let leads = 0
  for (const st of a.stats) {
    spend += st.spend
    impressions += st.impressions
    clicks += st.clicks
    leads += st.leads
  }
  return {
    topups,
    spend,
    balance: topups - spend,
    impressions,
    clicks,
    leads,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cr: clicks > 0 ? (leads / clicks) * 100 : 0,
    cpl: leads > 0 ? spend / leads : Number.POSITIVE_INFINITY,
    cpc: clicks > 0 ? spend / clicks : Number.POSITIVE_INFINITY,
  }
}

interface CurrencyBucket {
  currency: FinanceCurrency
  topups: number
  spend: number
  balance: number
  leads: number
}

interface ResourceAdSummary {
  leads: number
  clicks: number
  impressions: number
  ctr: number
  cr: number
  activeAccounts: number
  totalAccounts: number
  buckets: CurrencyBucket[]
  lowBalance: FinanceAdAccount[]
}

function summarizeAds(accounts: FinanceAdAccount[]): ResourceAdSummary {
  let leads = 0
  let clicks = 0
  let impressions = 0
  let activeAccounts = 0
  const map = new Map<FinanceCurrency, CurrencyBucket>()
  const lowBalance: FinanceAdAccount[] = []

  for (const a of accounts) {
    const m = accountMetrics(a)
    leads += m.leads
    clicks += m.clicks
    impressions += m.impressions
    if (a.status === 'active') activeAccounts += 1

    const bucket =
      map.get(a.currency) ??
      { currency: a.currency, topups: 0, spend: 0, balance: 0, leads: 0 }
    bucket.topups += m.topups
    bucket.spend += m.spend
    bucket.balance += m.balance
    bucket.leads += m.leads
    map.set(a.currency, bucket)

    if (a.status !== 'archived' && m.balance <= 0 && m.topups > 0) {
      lowBalance.push(a)
    }
  }

  return {
    leads,
    clicks,
    impressions,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cr: clicks > 0 ? (leads / clicks) * 100 : 0,
    activeAccounts,
    totalAccounts: accounts.length,
    buckets: [...map.values()].sort((a, b) => b.balance - a.balance),
    lowBalance,
  }
}

/* ================================================================== */
/* Table controls types                                                */
/* ================================================================== */

type SortField = 'date' | 'title' | 'amount' | 'status'
type SortDir = 'asc' | 'desc'
type StatusFilter = 'all' | FinanceEntryStatus
type SubTab = 'overview' | 'ads' | 'expenses'

/* ================================================================== */
/* Main                                                                */
/* ================================================================== */

export function FinanceAdmin({
  resources,
  sections,
  entries,
  adAccounts,
}: {
  resources: FinanceResource[]
  sections: FinanceSection[]
  entries: FinanceEntry[]
  adAccounts: FinanceAdAccount[]
}) {
  const [pending, startTransition] = useTransition()
  const [resourceId, setResourceId] = useState<string | null>(null)
  const [subTab, setSubTab] = useState<SubTab>('overview')

  // Dialog state
  const [resourceDialog, setResourceDialog] = useState<
    { mode: 'create' } | { mode: 'edit'; resource: FinanceResource } | null
  >(null)
  const [accountDialog, setAccountDialog] = useState<
    | { mode: 'create'; resourceId: string }
    | { mode: 'edit'; account: FinanceAdAccount }
    | null
  >(null)
  const [topupDialog, setTopupDialog] = useState<FinanceAdAccount | null>(null)
  const [statDialog, setStatDialog] = useState<FinanceAdAccount | null>(null)
  const [entryDialog, setEntryDialog] = useState<
    | { mode: 'create'; sectionId: string }
    | { mode: 'edit'; entry: FinanceEntry }
    | null
  >(null)
  const [confirm, setConfirm] = useState<{
    title: string
    description: string
    onConfirm: () => void
  } | null>(null)

  function run(fn: () => Promise<FinanceResult>, onOk?: () => void) {
    startTransition(async () => {
      const res = await fn()
      if (res.ok) {
        toast.success(res.message)
        onOk?.()
      } else {
        toast.error(res.message)
      }
    })
  }

  const activeResource =
    resources.find((r) => r.id === resourceId) ?? resources[0] ?? null

  const resourceAccounts = useMemo(
    () =>
      activeResource
        ? adAccounts.filter((a) => a.resourceId === activeResource.id)
        : [],
    [adAccounts, activeResource],
  )
  const resourceSections = useMemo(
    () =>
      activeResource
        ? sections.filter((s) => s.resourceId === activeResource.id)
        : [],
    [sections, activeResource],
  )
  const resourceEntries = useMemo(
    () =>
      activeResource
        ? entries.filter((e) => e.resourceId === activeResource.id)
        : [],
    [entries, activeResource],
  )

  const leadCountByResource = useMemo(() => {
    const map = new Map<string, number>()
    for (const a of adAccounts) {
      const leads = a.stats.reduce((s, st) => s + st.leads, 0)
      map.set(a.resourceId, (map.get(a.resourceId) ?? 0) + leads)
    }
    return map
  }, [adAccounts])

  /* ---------------- Resource bar ---------------- */

  const resourceBar = (
    <div className="flex flex-wrap items-center gap-2">
      {resources.map((r) => {
        const active = activeResource?.id === r.id
        const leads = leadCountByResource.get(r.id) ?? 0
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => {
              setResourceId(r.id)
              setSubTab('overview')
            }}
            className={cn(
              'group inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card text-foreground hover:bg-muted',
            )}
          >
            <span className="max-w-[180px] truncate">{r.name}</span>
            {r.archived ? (
              <Archive className="size-3.5 opacity-70" />
            ) : (
              <span
                className={cn(
                  'rounded-full px-1.5 text-xs tabular-nums',
                  active
                    ? 'bg-primary-foreground/20'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {formatInt(leads)} лид.
              </span>
            )}
          </button>
        )
      })}
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setResourceDialog({ mode: 'create' })}
      >
        <Plus className="size-4" /> Ресурс
      </Button>
    </div>
  )

  /* ---------------- Empty (no resources) ---------------- */

  if (!activeResource) {
    return (
      <div className="flex flex-col gap-4">
        {resourceBar}
        <EmptyState
          icon={Wallet}
          title="Пока нет ресурсов"
          description="Добавьте первый ресурс (например, site.com), чтобы вести рекламные кабинеты и расходы."
          action={
            <Button
              className="gap-1.5"
              onClick={() => setResourceDialog({ mode: 'create' })}
            >
              <Plus className="size-4" /> Добавить ресурс
            </Button>
          }
        />
        <ResourceDialog
          state={resourceDialog}
          pending={pending}
          onClose={() => setResourceDialog(null)}
          onSubmit={(fd) =>
            run(() => createResourceAction(fd), () => setResourceDialog(null))
          }
          onUpdate={() => {}}
          onDelete={() => {}}
        />
      </div>
    )
  }

  const adSummary = summarizeAds(resourceAccounts)

  return (
    <div className="flex flex-col gap-5">
      {resourceBar}

      {/* Resource header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">
            {activeResource.name}
          </h2>
          <Badge variant="outline" className="font-medium">
            {activeResource.currency}
          </Badge>
          {activeResource.archived ? (
            <Badge className="bg-muted text-muted-foreground" variant="outline">
              В архиве
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() =>
              setResourceDialog({ mode: 'edit', resource: activeResource })
            }
          >
            <Pencil className="size-4" /> Ресурс
          </Button>
        </div>
      </div>

      {activeResource.description ? (
        <p className="-mt-2 text-sm text-muted-foreground">
          {activeResource.description}
        </p>
      ) : null}

      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as SubTab)}>
        <TabsList>
          <TabsTrigger value="overview" className="gap-1.5">
            <BarChart3 className="size-4" /> Обзор
          </TabsTrigger>
          <TabsTrigger value="ads" className="gap-1.5">
            <Wallet className="size-4" /> Реклама
          </TabsTrigger>
          <TabsTrigger value="expenses" className="gap-1.5">
            <TrendingDown className="size-4" /> Расходы
          </TabsTrigger>
        </TabsList>

        {/* ---------------- Overview ---------------- */}
        <TabsContent value="overview" className="mt-4">
          <OverviewPanel
            summary={adSummary}
            accounts={resourceAccounts}
            entries={resourceEntries}
            resource={activeResource}
            onGoAds={() => setSubTab('ads')}
            onGoExpenses={() => setSubTab('expenses')}
          />
        </TabsContent>

        {/* ---------------- Ads ---------------- */}
        <TabsContent value="ads" className="mt-4">
          <AdsPanel
            accounts={resourceAccounts}
            pending={pending}
            onAdd={() =>
              setAccountDialog({ mode: 'create', resourceId: activeResource.id })
            }
            onEdit={(account) => setAccountDialog({ mode: 'edit', account })}
            onTopup={(account) => setTopupDialog(account)}
            onStat={(account) => setStatDialog(account)}
            onDeleteAccount={(account) =>
              setConfirm({
                title: 'Удалить кабинет?',
                description: `«${account.name}» и вся история пополнений и статистики будут удалены безвозвратно.`,
                onConfirm: () =>
                  run(() => deleteAdAccountAction(account.id), () =>
                    setConfirm(null),
                  ),
              })
            }
            onDeleteTopup={(id) =>
              run(() => deleteAdTopupAction(id))
            }
            onDeleteStat={(id) => run(() => deleteAdStatAction(id))}
          />
        </TabsContent>

        {/* ---------------- Expenses ---------------- */}
        <TabsContent value="expenses" className="mt-4">
          <ExpensesPanel
            resource={activeResource}
            sections={resourceSections}
            entries={resourceEntries}
            pending={pending}
            run={run}
            onAddEntry={(sectionId) =>
              setEntryDialog({ mode: 'create', sectionId })
            }
            onEditEntry={(entry) => setEntryDialog({ mode: 'edit', entry })}
            onDeleteEntry={(entry) =>
              setConfirm({
                title: 'Удалить расход?',
                description: `«${entry.title}» и его чек-лист будут удалены.`,
                onConfirm: () =>
                  run(() => deleteEntryAction(entry.id), () =>
                    setConfirm(null),
                  ),
              })
            }
            onDeleteSection={(section) =>
              setConfirm({
                title: 'Удалить вкладку?',
                description: `«${section.name}» и все записи внутри будут удалены.`,
                onConfirm: () =>
                  run(() => deleteSectionAction(section.id), () =>
                    setConfirm(null),
                  ),
              })
            }
          />
        </TabsContent>
      </Tabs>

      {/* Delete resource lives in the resource dialog */}

      {/* ---------------- Dialogs ---------------- */}
      <ResourceDialog
        state={resourceDialog}
        pending={pending}
        onClose={() => setResourceDialog(null)}
        onSubmit={(fd) =>
          run(() => createResourceAction(fd), () => setResourceDialog(null))
        }
        onUpdate={(id, fd) =>
          run(() => updateResourceAction(id, fd), () => setResourceDialog(null))
        }
        onDelete={(resource) =>
          setConfirm({
            title: 'Удалить ресурс?',
            description: `«${resource.name}» со всеми кабинетами, вкладками и записями будет удалён безвозвратно.`,
            onConfirm: () =>
              run(() => deleteResourceAction(resource.id), () => {
                setConfirm(null)
                setResourceDialog(null)
                setResourceId(null)
              }),
          })
        }
      />

      <AdAccountDialog
        state={accountDialog}
        pending={pending}
        onClose={() => setAccountDialog(null)}
        onCreate={(rid, fd) =>
          run(() => createAdAccountAction(rid, fd), () =>
            setAccountDialog(null),
          )
        }
        onUpdate={(id, fd) =>
          run(() => updateAdAccountAction(id, fd), () => setAccountDialog(null))
        }
      />

      <TopupDialog
        account={topupDialog}
        pending={pending}
        onClose={() => setTopupDialog(null)}
        onSubmit={(id, fd) =>
          run(() => addAdTopupAction(id, fd), () => setTopupDialog(null))
        }
      />

      <StatDialog
        account={statDialog}
        pending={pending}
        onClose={() => setStatDialog(null)}
        onSubmit={(id, fd) =>
          run(() => addAdStatAction(id, fd), () => setStatDialog(null))
        }
      />

      <EntryDialog
        state={entryDialog}
        pending={pending}
        onClose={() => setEntryDialog(null)}
        onCreate={(sid, fd) =>
          run(() => createEntryAction(sid, fd), () => setEntryDialog(null))
        }
        onUpdate={(id, fd) =>
          run(() => updateEntryAction(id, fd), () => setEntryDialog(null))
        }
      />

      <ConfirmDialog
        state={confirm}
        pending={pending}
        onClose={() => setConfirm(null)}
      />
    </div>
  )
}

/* ================================================================== */
/* Overview panel                                                      */
/* ================================================================== */

function OverviewPanel({
  summary,
  accounts,
  entries,
  resource,
  onGoAds,
  onGoExpenses,
}: {
  summary: ResourceAdSummary
  accounts: FinanceAdAccount[]
  entries: FinanceEntry[]
  resource: FinanceResource
  onGoAds: () => void
  onGoExpenses: () => void
}) {
  const expenseTotal = entries
    .filter((e) => e.status !== 'cancelled')
    .reduce((s, e) => s + e.amount, 0)
  const unpaid = entries.filter(
    (e) => e.status === 'planned' || e.status === 'in_progress',
  ).length

  return (
    <div className="flex flex-col gap-5">
      {summary.lowBalance.length > 0 ? (
        <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4">
          <TrendingDown className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="text-sm">
            <p className="font-medium text-destructive">
              Заканчивается баланс: {summary.lowBalance.length}
            </p>
            <p className="text-muted-foreground">
              {summary.lowBalance.map((a) => a.name).join(', ')} — пополните
              баланс, чтобы реклама не остановилась.
            </p>
          </div>
        </Card>
      ) : null}

      {/* KPI row (unit-less metrics — safe to sum across currencies) */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Лиды"
          value={formatInt(summary.leads)}
          icon={Users}
          hint="Из статистики кабинетов"
        />
        <StatCard
          label="Клики"
          value={formatInt(summary.clicks)}
          icon={MousePointerClick}
          hint={`CTR ${formatPct(summary.ctr)}`}
        />
        <StatCard
          label="Конверсия в лид"
          value={formatPct(summary.cr)}
          icon={Target}
          hint={`${formatInt(summary.impressions)} показов`}
        />
        <StatCard
          label="Кабинеты"
          value={`${summary.activeAccounts}/${summary.totalAccounts}`}
          icon={Wallet}
          hint="Активные / всего"
        />
      </div>

      {/* Balances by currency */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Баланс рекламы по валютам</h3>
          <Button variant="ghost" size="sm" onClick={onGoAds}>
            Кабинеты <ChevronRight className="size-4" />
          </Button>
        </div>
        {summary.buckets.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Ещё нет рекламных кабинетов.
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {summary.buckets.map((b) => {
              const cpl = b.leads > 0 ? b.spend / b.leads : null
              const low = b.balance <= 0
              return (
                <Card key={b.currency} className="p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      Баланс {b.currency}
                    </span>
                    <Wallet className="size-4 text-muted-foreground" />
                  </div>
                  <div
                    className={cn(
                      'mt-2 text-2xl font-semibold tabular-nums',
                      low ? 'text-destructive' : 'text-foreground',
                    )}
                  >
                    {formatMoney(b.balance, b.currency)}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <Metric label="Пополнено" value={formatMoney(b.topups, b.currency)} />
                    <Metric label="Расход" value={formatMoney(b.spend, b.currency)} />
                    <Metric label="Лиды" value={formatInt(b.leads)} />
                    <Metric
                      label="CPL"
                      value={cpl == null ? '—' : formatMoney(cpl, b.currency)}
                    />
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Accounts quick list */}
      {accounts.length > 0 ? (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Кабинеты</h3>
          <Card className="divide-y divide-border p-0">
            {accounts.map((a) => {
              const m = accountMetrics(a)
              return (
                <div
                  key={a.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3"
                >
                  <div className="flex min-w-[160px] flex-1 items-center gap-2">
                    <span
                      className={cn(
                        'size-2 rounded-full',
                        AD_STATUS_META[a.status].dot,
                      )}
                    />
                    <span className="truncate font-medium">{a.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {PLATFORM_META[a.platform]}
                    </span>
                  </div>
                  <div className="tabular-nums text-sm">
                    <span className="text-muted-foreground">Баланс: </span>
                    <span
                      className={cn(
                        'font-semibold',
                        m.balance <= 0 && 'text-destructive',
                      )}
                    >
                      {formatMoney(m.balance, a.currency)}
                    </span>
                  </div>
                  <div className="tabular-nums text-sm text-muted-foreground">
                    {formatInt(m.leads)} лид. ·{' '}
                    {m.cpl === Number.POSITIVE_INFINITY
                      ? 'CPL —'
                      : `CPL ${formatMoney(m.cpl, a.currency)}`}
                  </div>
                </div>
              )
            })}
          </Card>
        </div>
      ) : null}

      {/* Expenses summary */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Прочие расходы</h3>
          <Button variant="ghost" size="sm" onClick={onGoExpenses}>
            Открыть <ChevronRight className="size-4" />
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <StatCard
            label="Всего расходов"
            value={formatMoney(expenseTotal, resource.currency)}
            icon={TrendingDown}
            hint={`${entries.length} записей`}
          />
          <StatCard
            label="Не оплачено"
            value={formatInt(unpaid)}
            icon={CreditCard}
            hint="Запланировано / в работе"
          />
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wide">{label}</span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </div>
  )
}

/* ================================================================== */
/* Ads panel                                                           */
/* ================================================================== */

function AdsPanel({
  accounts,
  pending,
  onAdd,
  onEdit,
  onTopup,
  onStat,
  onDeleteAccount,
  onDeleteTopup,
  onDeleteStat,
}: {
  accounts: FinanceAdAccount[]
  pending: boolean
  onAdd: () => void
  onEdit: (a: FinanceAdAccount) => void
  onTopup: (a: FinanceAdAccount) => void
  onStat: (a: FinanceAdAccount) => void
  onDeleteAccount: (a: FinanceAdAccount) => void
  onDeleteTopup: (id: string) => void
  onDeleteStat: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {accounts.length} кабинет(ов)
        </p>
        <Button className="gap-1.5" onClick={onAdd}>
          <Plus className="size-4" /> Кабинет
        </Button>
      </div>

      {accounts.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="Нет рекламных кабинетов"
          description="Добавьте кабинет (Яндекс Директ, Google Ads и т.д.), затем пополняйте баланс и вносите статистику."
          action={
            <Button className="gap-1.5" onClick={onAdd}>
              <Plus className="size-4" /> Добавить кабинет
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {accounts.map((a) => (
            <AdAccountCard
              key={a.id}
              account={a}
              pending={pending}
              onEdit={() => onEdit(a)}
              onTopup={() => onTopup(a)}
              onStat={() => onStat(a)}
              onDelete={() => onDeleteAccount(a)}
              onDeleteTopup={onDeleteTopup}
              onDeleteStat={onDeleteStat}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function AdAccountCard({
  account,
  pending,
  onEdit,
  onTopup,
  onStat,
  onDelete,
  onDeleteTopup,
  onDeleteStat,
}: {
  account: FinanceAdAccount
  pending: boolean
  onEdit: () => void
  onTopup: () => void
  onStat: () => void
  onDelete: () => void
  onDeleteTopup: (id: string) => void
  onDeleteStat: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const m = accountMetrics(account)
  const status = AD_STATUS_META[account.status]
  const low = m.balance <= 0

  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{account.name}</span>
            <Badge
              variant="outline"
              className={cn('gap-1.5 font-medium', status.className)}
            >
              <span className={cn('size-1.5 rounded-full', status.dot)} />
              {status.label}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {PLATFORM_META[account.platform]}
            {account.accountRef ? ` · ${account.accountRef}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={onEdit}
            aria-label="Изменить кабинет"
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-destructive hover:text-destructive"
            onClick={onDelete}
            aria-label="Удалить кабинет"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {/* Balance */}
      <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
        <span className="text-xs text-muted-foreground">Баланс</span>
        <div
          className={cn(
            'text-3xl font-bold tabular-nums',
            low ? 'text-destructive' : 'text-foreground',
          )}
        >
          {formatMoney(m.balance, account.currency)}
        </div>
        <div className="mt-1 text-xs text-muted-foreground tabular-nums">
          Пополнено {formatMoney(m.topups, account.currency)} · Расход{' '}
          {formatMoney(m.spend, account.currency)}
        </div>
      </div>

      {/* Metrics grid */}
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <MiniMetric label="Показы" value={formatInt(m.impressions)} />
        <MiniMetric label="Клики" value={formatInt(m.clicks)} />
        <MiniMetric label="Лиды" value={formatInt(m.leads)} />
        <MiniMetric label="CTR" value={formatPct(m.ctr)} />
        <MiniMetric label="Конв." value={formatPct(m.cr)} />
        <MiniMetric
          label="CPL"
          value={
            m.cpl === Number.POSITIVE_INFINITY
              ? '—'
              : formatMoney(m.cpl, account.currency)
          }
        />
      </div>

      {account.note ? (
        <p className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {account.note}
        </p>
      ) : null}

      {/* Actions */}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" className="gap-1.5" onClick={onTopup}>
          <CreditCard className="size-4" /> Пополнить
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={onStat}
        >
          <BarChart3 className="size-4" /> Статистика
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto gap-1.5"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
          История
        </Button>
      </div>

      {/* History */}
      {open ? (
        <div className="mt-3 grid gap-4 border-t border-border pt-3 md:grid-cols-2">
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Пополнения
            </h4>
            {account.topups.length === 0 ? (
              <p className="text-xs text-muted-foreground">Нет пополнений.</p>
            ) : (
              <ul className="space-y-1.5">
                {account.topups.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-2.5 py-1.5 text-sm"
                  >
                    <div className="min-w-0">
                      <span className="font-medium tabular-nums text-success">
                        +{formatMoney(t.amount, account.currency)}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {formatDate(t.topupDate)}
                      </span>
                      {t.note ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {t.note}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => onDeleteTopup(t.id)}
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label="Удалить пополнение"
                    >
                      <X className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Статистика
            </h4>
            {account.stats.length === 0 ? (
              <p className="text-xs text-muted-foreground">Нет записей.</p>
            ) : (
              <ul className="space-y-1.5">
                {account.stats.map((st) => (
                  <li
                    key={st.id}
                    className="flex items-start justify-between gap-2 rounded-md bg-muted/30 px-2.5 py-1.5 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="text-xs text-muted-foreground">
                        {formatDate(st.periodStart)} — {formatDate(st.periodEnd)}
                      </div>
                      <div className="tabular-nums">
                        <span className="font-medium text-destructive">
                          −{formatMoney(st.spend, account.currency)}
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {formatInt(st.clicks)} кл · {formatInt(st.leads)} лид.
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => onDeleteStat(st.id)}
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label="Удалить запись статистики"
                    >
                      <X className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  )
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-1 py-2">
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}

/* ================================================================== */
/* Expenses panel                                                      */
/* ================================================================== */

function ExpensesPanel({
  resource,
  sections,
  entries,
  pending,
  run,
  onAddEntry,
  onEditEntry,
  onDeleteEntry,
  onDeleteSection,
}: {
  resource: FinanceResource
  sections: FinanceSection[]
  entries: FinanceEntry[]
  pending: boolean
  run: (fn: () => Promise<FinanceResult>, onOk?: () => void) => void
  onAddEntry: (sectionId: string) => void
  onEditEntry: (entry: FinanceEntry) => void
  onDeleteEntry: (entry: FinanceEntry) => void
  onDeleteSection: (section: FinanceSection) => void
}) {
  const [sectionId, setSectionId] = useState<string | null>(null)
  const [newSection, setNewSection] = useState('')
  const [renaming, setRenaming] = useState<FinanceSection | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortField, setSortField] = useState<SortField>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const activeSection =
    sections.find((s) => s.id === sectionId) ?? sections[0] ?? null

  const sectionEntries = useMemo(
    () =>
      activeSection
        ? entries.filter((e) => e.sectionId === activeSection.id)
        : [],
    [entries, activeSection],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = sectionEntries.filter((e) => {
      if (statusFilter !== 'all' && e.status !== statusFilter) return false
      if (
        q &&
        !e.title.toLowerCase().includes(q) &&
        !e.vendor.toLowerCase().includes(q) &&
        !e.notes.toLowerCase().includes(q)
      ) {
        return false
      }
      return true
    })
    const dir = sortDir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      switch (sortField) {
        case 'title':
          return a.title.localeCompare(b.title) * dir
        case 'amount':
          return (a.amount - b.amount) * dir
        case 'status':
          return a.status.localeCompare(b.status) * dir
        default:
          return (
            (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0) *
            dir
          )
      }
    })
  }, [sectionEntries, search, statusFilter, sortField, sortDir])

  const sectionTotal = sectionEntries
    .filter((e) => e.status !== 'cancelled')
    .reduce((s, e) => s + e.amount, 0)

  function totalFor(id: string) {
    return entries
      .filter((e) => e.sectionId === id && e.status !== 'cancelled')
      .reduce((s, e) => s + e.amount, 0)
  }

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir(field === 'title' ? 'asc' : 'desc')
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Section tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {sections.map((s) => {
          const active = activeSection?.id === s.id
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSectionId(s.id)}
              className={cn(
                'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors',
                active
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-card hover:bg-muted',
              )}
            >
              <Layers className="size-3.5 text-muted-foreground" />
              <span className="max-w-[160px] truncate font-medium">
                {s.name}
              </span>
              <span className="tabular-nums text-xs text-muted-foreground">
                {formatMoney(totalFor(s.id), resource.currency)}
              </span>
            </button>
          )
        })}
        <AddSectionInline
          value={newSection}
          onChange={setNewSection}
          pending={pending}
          onSubmit={() => {
            const name = newSection.trim()
            if (!name) return
            run(() => createSectionAction(resource.id, name), () =>
              setNewSection(''),
            )
          }}
        />
      </div>

      {!activeSection ? (
        <EmptyState
          icon={FolderPlus}
          title="Нет вкладок расходов"
          description="Создайте вкладку (например, «Материалы» или «Хостинг»), чтобы добавлять расходы."
        />
      ) : (
        <>
          {/* Section toolbar */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">{activeSection.name}</h3>
                <Badge variant="outline" className="tabular-nums font-medium">
                  {formatMoney(sectionTotal, resource.currency)}
                </Badge>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    setRenaming(activeSection)
                    setRenameValue(activeSection.name)
                  }}
                >
                  <Pencil className="size-4" /> Переименовать
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-destructive hover:text-destructive"
                  onClick={() => onDeleteSection(activeSection)}
                  aria-label="Удалить вкладку"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Поиск по названию, контрагенту, заметке…"
                  className="pl-3"
                />
              </div>
              <Select
                value={statusFilter}
                onValueChange={(v) => setStatusFilter(v as StatusFilter)}
              >
                <SelectTrigger className="w-full sm:w-44">
                  <SelectValue placeholder="Статус" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все статусы</SelectItem>
                  {FINANCE_ENTRY_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_META[s].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                className="gap-1.5"
                onClick={() => onAddEntry(activeSection.id)}
              >
                <Plus className="size-4" /> Расход
              </Button>
            </div>
          </div>

          {/* Table */}
          {filtered.length === 0 ? (
            <EmptyState
              icon={ListChecks}
              title="Нет расходов"
              description="Добавьте первый расход в эту вкладку."
              action={
                <Button
                  className="gap-1.5"
                  onClick={() => onAddEntry(activeSection.id)}
                >
                  <Plus className="size-4" /> Добавить расход
                </Button>
              }
            />
          ) : (
            <Card className="overflow-hidden p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="w-8 px-3 py-2.5" />
                      <SortableTh
                        label="Расход"
                        field="title"
                        active={sortField}
                        dir={sortDir}
                        onSort={toggleSort}
                      />
                      <th className="px-3 py-2.5 font-medium">Контрагент</th>
                      <SortableTh
                        label="Статус"
                        field="status"
                        active={sortField}
                        dir={sortDir}
                        onSort={toggleSort}
                      />
                      <SortableTh
                        label="Дата"
                        field="date"
                        active={sortField}
                        dir={sortDir}
                        onSort={toggleSort}
                      />
                      <SortableTh
                        label="Сумма"
                        field="amount"
                        active={sortField}
                        dir={sortDir}
                        onSort={toggleSort}
                        align="right"
                      />
                      <th className="w-20 px-3 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((e) => {
                      const isOpen = expanded.has(e.id)
                      const doneTasks = e.tasks.filter((t) => t.done).length
                      return (
                        <ExpenseRow
                          key={e.id}
                          entry={e}
                          currency={resource.currency}
                          isOpen={isOpen}
                          doneTasks={doneTasks}
                          pending={pending}
                          onToggle={() => toggleExpanded(e.id)}
                          onEdit={() => onEditEntry(e)}
                          onDelete={() => onDeleteEntry(e)}
                          run={run}
                        />
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}

      {/* Rename section dialog */}
      <Dialog
        open={renaming != null}
        onOpenChange={(o) => {
          if (!o) setRenaming(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Переименовать вкладку</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-section">Название</Label>
            <Input
              id="rename-section"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Отмена</Button>} />
            <Button
              disabled={pending || !renameValue.trim()}
              onClick={() => {
                if (!renaming) return
                run(
                  () => renameSectionAction(renaming.id, renameValue.trim()),
                  () => setRenaming(null),
                )
              }}
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                'Сохранить'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function AddSectionInline({
  value,
  onChange,
  pending,
  onSubmit,
}: {
  value: string
  onChange: (v: string) => void
  pending: boolean
  onSubmit: () => void
}) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setOpen(true)}
      >
        <FolderPlus className="size-4" /> Вкладка
      </Button>
    )
  }
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Название вкладки"
        className="h-8 w-44"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false)
            onChange('')
          }
        }}
      />
      <Button type="submit" size="sm" disabled={pending || !value.trim()}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-8"
        onClick={() => {
          setOpen(false)
          onChange('')
        }}
      >
        <X className="size-4" />
      </Button>
    </form>
  )
}

function SortableTh({
  label,
  field,
  active,
  dir,
  onSort,
  align = 'left',
}: {
  label: string
  field: SortField
  active: SortField
  dir: SortDir
  onSort: (f: SortField) => void
  align?: 'left' | 'right'
}) {
  return (
    <th
      className={cn(
        'px-3 py-2.5 font-medium',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={cn(
          'inline-flex items-center gap-1 hover:text-foreground',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        {label}
        {active === field ? (
          dir === 'asc' ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-50" />
        )}
      </button>
    </th>
  )
}

function ExpenseRow({
  entry,
  currency,
  isOpen,
  doneTasks,
  pending,
  onToggle,
  onEdit,
  onDelete,
  run,
}: {
  entry: FinanceEntry
  currency: FinanceCurrency
  isOpen: boolean
  doneTasks: number
  pending: boolean
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
  run: (fn: () => Promise<FinanceResult>, onOk?: () => void) => void
}) {
  const [taskInput, setTaskInput] = useState('')
  const total = entry.tasks.length
  const progress = total > 0 ? Math.round((doneTasks / total) * 100) : 0

  return (
    <>
      <tr className="border-b border-border last:border-0 hover:bg-muted/30">
        <td className="px-3 py-2.5 align-top">
          <button
            type="button"
            onClick={onToggle}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Раскрыть детали"
          >
            {isOpen ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </button>
        </td>
        <td className="px-3 py-2.5 align-top">
          <div className="font-medium">{entry.title}</div>
          {total > 0 ? (
            <div className="mt-0.5 text-xs text-muted-foreground">
              Задачи: {doneTasks}/{total}
            </div>
          ) : null}
        </td>
        <td className="px-3 py-2.5 align-top text-muted-foreground">
          {entry.vendor || '—'}
        </td>
        <td className="px-3 py-2.5 align-top">
          <Badge
            variant="outline"
            className={cn('font-medium', STATUS_META[entry.status].className)}
          >
            {STATUS_META[entry.status].label}
          </Badge>
        </td>
        <td className="px-3 py-2.5 align-top whitespace-nowrap text-muted-foreground">
          {formatDate(entry.entryDate)}
          {entry.dueDate ? (
            <div className="text-xs">до {formatDate(entry.dueDate)}</div>
          ) : null}
        </td>
        <td className="px-3 py-2.5 align-top text-right font-semibold tabular-nums">
          {formatMoney(entry.amount, currency)}
        </td>
        <td className="px-3 py-2.5 align-top">
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={onEdit}
              aria-label="Изменить"
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-destructive hover:text-destructive"
              onClick={onDelete}
              aria-label="Удалить"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </td>
      </tr>
      {isOpen ? (
        <tr className="border-b border-border bg-muted/20">
          <td />
          <td colSpan={6} className="px-3 py-3">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Заметки / ответы
                </h4>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {entry.notes || 'Нет заметок.'}
                </p>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Чек-лист задач
                  </h4>
                  {total > 0 ? (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {doneTasks}/{total} · {progress}%
                    </span>
                  ) : null}
                </div>
                {total > 0 ? (
                  <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-success transition-all"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                ) : null}
                <ul className="space-y-1">
                  {entry.tasks.map((t) => (
                    <li key={t.id} className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(() => toggleTaskAction(t.id, !t.done))
                        }
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center rounded border',
                          t.done
                            ? 'border-success bg-success text-success-foreground'
                            : 'border-input',
                        )}
                        aria-label={t.done ? 'Снять отметку' : 'Отметить выполненным'}
                      >
                        {t.done ? <Check className="size-3" /> : null}
                      </button>
                      <span
                        className={cn(
                          'flex-1 text-sm',
                          t.done && 'text-muted-foreground line-through',
                        )}
                      >
                        {t.label}
                      </span>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => run(() => deleteTaskAction(t.id))}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label="Удалить пункт"
                      >
                        <X className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
                <form
                  className="mt-2 flex items-center gap-1.5"
                  onSubmit={(ev) => {
                    ev.preventDefault()
                    const label = taskInput.trim()
                    if (!label) return
                    run(
                      () => addTaskAction(entry.id, label),
                      () => setTaskInput(''),
                    )
                  }}
                >
                  <Input
                    value={taskInput}
                    onChange={(ev) => setTaskInput(ev.target.value)}
                    placeholder="Новый пункт…"
                    className="h-8"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={pending || !taskInput.trim()}
                  >
                    <Plus className="size-4" />
                  </Button>
                </form>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}

/* ================================================================== */
/* Dialogs                                                             */
/* ================================================================== */

function ResourceDialog({
  state,
  pending,
  onClose,
  onSubmit,
  onUpdate,
  onDelete,
}: {
  state:
    | { mode: 'create' }
    | { mode: 'edit'; resource: FinanceResource }
    | null
  pending: boolean
  onClose: () => void
  onSubmit: (fd: FormData) => void
  onUpdate: (id: string, fd: FormData) => void
  onDelete: (resource: FinanceResource) => void
}) {
  const editing = state?.mode === 'edit' ? state.resource : null
  return (
    <Dialog open={state != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const fd = new FormData(e.currentTarget)
            if (editing) onUpdate(editing.id, fd)
            else onSubmit(fd)
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Изменить ресурс' : 'Новый ресурс'}
            </DialogTitle>
            <DialogDescription>
              Ресурс — это площадка (например, site.com), внутри которой ведутся
              рекламные кабинеты и расходы.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="res-name">Название</Label>
              <Input
                id="res-name"
                name="name"
                defaultValue={editing?.name ?? ''}
                placeholder="site.com"
                autoFocus
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="res-desc">Описание</Label>
              <Textarea
                id="res-desc"
                name="description"
                defaultValue={editing?.description ?? ''}
                placeholder="Комментарий к ресурсу"
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="res-currency">Валюта расходов</Label>
                <CurrencySelect
                  name="currency"
                  defaultValue={editing?.currency ?? 'USDT'}
                />
              </div>
              {editing ? (
                <div className="space-y-2">
                  <Label htmlFor="res-archived">Статус</Label>
                  <Select
                    name="archived"
                    defaultValue={editing.archived ? 'true' : 'false'}
                  >
                    <SelectTrigger id="res-archived" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="false">Активен</SelectItem>
                      <SelectItem value="true">В архиве</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
          </div>
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => onDelete(editing)}
              >
                <Trash2 className="size-4" /> Удалить
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <DialogClose
                render={
                  <Button type="button" variant="outline">
                    Отмена
                  </Button>
                }
              />
              <Button type="submit" disabled={pending}>
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : editing ? (
                  'Сохранить'
                ) : (
                  'Добавить'
                )}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AdAccountDialog({
  state,
  pending,
  onClose,
  onCreate,
  onUpdate,
}: {
  state:
    | { mode: 'create'; resourceId: string }
    | { mode: 'edit'; account: FinanceAdAccount }
    | null
  pending: boolean
  onClose: () => void
  onCreate: (resourceId: string, fd: FormData) => void
  onUpdate: (id: string, fd: FormData) => void
}) {
  const editing = state?.mode === 'edit' ? state.account : null
  return (
    <Dialog open={state != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const fd = new FormData(e.currentTarget)
            if (editing) onUpdate(editing.id, fd)
            else if (state?.mode === 'create') onCreate(state.resourceId, fd)
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Изменить кабинет' : 'Новый рекламный кабинет'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="acc-name">Название</Label>
              <Input
                id="acc-name"
                name="name"
                defaultValue={editing?.name ?? ''}
                placeholder="Основной кабинет"
                autoFocus
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="acc-platform">Площадка</Label>
                <Select
                  name="platform"
                  defaultValue={editing?.platform ?? 'yandex_direct'}
                >
                  <SelectTrigger id="acc-platform" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AD_PLATFORMS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {PLATFORM_META[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="acc-status">Статус</Label>
                <Select
                  name="status"
                  defaultValue={editing?.status ?? 'active'}
                >
                  <SelectTrigger id="acc-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AD_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {AD_STATUS_META[s].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="acc-ref">Логин / номер</Label>
                <Input
                  id="acc-ref"
                  name="accountRef"
                  defaultValue={editing?.accountRef ?? ''}
                  placeholder="ID кабинета"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="acc-currency">Валюта</Label>
                <CurrencySelect
                  name="currency"
                  defaultValue={editing?.currency ?? 'RUB'}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="acc-note">Заметка</Label>
              <Textarea
                id="acc-note"
                name="note"
                defaultValue={editing?.note ?? ''}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline">
                  Отмена
                </Button>
              }
            />
            <Button type="submit" disabled={pending}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : editing ? (
                'Сохранить'
              ) : (
                'Добавить'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function TopupDialog({
  account,
  pending,
  onClose,
  onSubmit,
}: {
  account: FinanceAdAccount | null
  pending: boolean
  onClose: () => void
  onSubmit: (id: string, fd: FormData) => void
}) {
  return (
    <Dialog open={account != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!account) return
            onSubmit(account.id, new FormData(e.currentTarget))
          }}
        >
          <DialogHeader>
            <DialogTitle>Пополнить баланс</DialogTitle>
            <DialogDescription>
              {account
                ? `${account.name} · ${CURRENCY_SYMBOL[account.currency]} ${account.currency}`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="top-amount">Сумма</Label>
                <Input
                  id="top-amount"
                  name="amount"
                  inputMode="decimal"
                  placeholder="10000"
                  autoFocus
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="top-date">Дата</Label>
                <Input
                  id="top-date"
                  name="topupDate"
                  type="date"
                  defaultValue={todayISO()}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="top-note">Комментарий</Label>
              <Input id="top-note" name="note" placeholder="Например: перевод с карты" />
            </div>
          </div>
          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline">
                  Отмена
                </Button>
              }
            />
            <Button type="submit" disabled={pending}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                'Пополнить'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function StatDialog({
  account,
  pending,
  onClose,
  onSubmit,
}: {
  account: FinanceAdAccount | null
  pending: boolean
  onClose: () => void
  onSubmit: (id: string, fd: FormData) => void
}) {
  return (
    <Dialog open={account != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!account) return
            onSubmit(account.id, new FormData(e.currentTarget))
          }}
        >
          <DialogHeader>
            <DialogTitle>Внести статистику</DialogTitle>
            <DialogDescription>
              {account
                ? `${account.name} — расход спишется с баланса, лиды пойдут в метрики.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="stat-start">Начало периода</Label>
                <Input
                  id="stat-start"
                  name="periodStart"
                  type="date"
                  defaultValue={todayISO()}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="stat-end">Конец периода</Label>
                <Input
                  id="stat-end"
                  name="periodEnd"
                  type="date"
                  defaultValue={todayISO()}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor="stat-impr">Показы</Label>
                <Input id="stat-impr" name="impressions" inputMode="numeric" defaultValue="0" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="stat-clicks">Клики</Label>
                <Input id="stat-clicks" name="clicks" inputMode="numeric" defaultValue="0" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="stat-leads">Лиды</Label>
                <Input id="stat-leads" name="leads" inputMode="numeric" defaultValue="0" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="stat-spend">
                Расход {account ? `(${account.currency})` : ''}
              </Label>
              <Input
                id="stat-spend"
                name="spend"
                inputMode="decimal"
                placeholder="0"
                autoFocus
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="stat-note">Комментарий</Label>
              <Input id="stat-note" name="note" placeholder="Например: неделя 1" />
            </div>
          </div>
          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline">
                  Отмена
                </Button>
              }
            />
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : 'Внести'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function EntryDialog({
  state,
  pending,
  onClose,
  onCreate,
  onUpdate,
}: {
  state:
    | { mode: 'create'; sectionId: string }
    | { mode: 'edit'; entry: FinanceEntry }
    | null
  pending: boolean
  onClose: () => void
  onCreate: (sectionId: string, fd: FormData) => void
  onUpdate: (id: string, fd: FormData) => void
}) {
  const editing = state?.mode === 'edit' ? state.entry : null
  return (
    <Dialog open={state != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const fd = new FormData(e.currentTarget)
            if (editing) onUpdate(editing.id, fd)
            else if (state?.mode === 'create') onCreate(state.sectionId, fd)
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Изменить расход' : 'Новый расход'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="entry-title">Название</Label>
              <Input
                id="entry-title"
                name="title"
                defaultValue={editing?.title ?? ''}
                placeholder="Например: закупка контента"
                autoFocus
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="entry-vendor">Контрагент</Label>
                <Input
                  id="entry-vendor"
                  name="vendor"
                  defaultValue={editing?.vendor ?? ''}
                  placeholder="Кому платим"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="entry-amount">Сумма</Label>
                <Input
                  id="entry-amount"
                  name="amount"
                  inputMode="decimal"
                  defaultValue={editing ? String(editing.amount) : ''}
                  placeholder="0"
                  required
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor="entry-status">Статус</Label>
                <Select
                  name="status"
                  defaultValue={editing?.status ?? 'planned'}
                >
                  <SelectTrigger id="entry-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FINANCE_ENTRY_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {STATUS_META[s].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="entry-date">Дата</Label>
                <Input
                  id="entry-date"
                  name="entryDate"
                  type="date"
                  defaultValue={editing?.entryDate ?? todayISO()}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="entry-due">Оплатить до</Label>
                <Input
                  id="entry-due"
                  name="dueDate"
                  type="date"
                  defaultValue={editing?.dueDate ?? ''}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="entry-notes">Заметки / ответы</Label>
              <Textarea
                id="entry-notes"
                name="notes"
                defaultValue={editing?.notes ?? ''}
                rows={3}
                placeholder="Детали, ответы, ссылки…"
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline">
                  Отмена
                </Button>
              }
            />
            <Button type="submit" disabled={pending}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : editing ? (
                'Сохранить'
              ) : (
                'Добавить'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function CurrencySelect({
  name,
  defaultValue,
}: {
  name: string
  defaultValue: FinanceCurrency
}) {
  return (
    <Select name={name} defaultValue={defaultValue}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {FINANCE_CURRENCIES.map((c) => (
          <SelectItem key={c} value={c}>
            {c} {CURRENCY_SYMBOL[c]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ConfirmDialog({
  state,
  pending,
  onClose,
}: {
  state: {
    title: string
    description: string
    onConfirm: () => void
  } | null
  pending: boolean
  onClose: () => void
}) {
  return (
    <Dialog open={state != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.title}</DialogTitle>
          <DialogDescription>{state?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Отмена</Button>} />
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => state?.onConfirm()}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : 'Удалить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
