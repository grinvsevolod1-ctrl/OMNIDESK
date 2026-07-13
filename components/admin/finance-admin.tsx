'use client'

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Archive,
  AtSign,
  AlertTriangle,
  BarChart3,
  ClipboardCopy,
  Download,
  Table2,
  Upload,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  CreditCard,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  FolderPlus,
  Globe,
  KeyRound,
  Layers,
  Link as LinkIcon,
  ListChecks,
  Loader2,
  Lock,
  Mail,
  MousePointerClick,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  Star,
  Target,
  TerminalSquare,
  Trash2,
  TrendingDown,
  User,
  Users,
  Vault,
  Wallet,
  X,
  type LucideIcon,
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
  createVaultItemAction,
  importVaultItemsAction,
  deleteAdAccountAction,
  deleteAdStatAction,
  deleteAdTopupAction,
  deleteEntryAction,
  deleteResourceAction,
  deleteSectionAction,
  deleteTaskAction,
  deleteVaultItemAction,
  renameSectionAction,
  syncAdAccountAction,
  toggleTaskAction,
  toggleVaultFavoriteAction,
  updateAdAccountAction,
  updateEntryAction,
  updateResourceAction,
  updateVaultItemAction,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { AdsTrendChart } from './finance-charts'
import {
  downloadText,
  findReusedSecrets,
  parseVaultFile,
  scorePassword,
  toCSV,
  toJSON,
  type ParsedVaultRow,
  type PasswordStrength,
} from '@/lib/vault-utils'
import { EmptyState, StatCard } from '@/components/page-parts'
import { cn } from '@/lib/utils'
import {
  AD_PLATFORMS,
  AD_STATUSES,
  DEFAULT_USD_RATES,
  FINANCE_CURRENCIES,
  FINANCE_ENTRY_STATUSES,
  VAULT_CATEGORIES,
  adEffectiveMetrics,
  toUsd,
  type UsdRates,
  type AdPlatform,
  type AdStatus,
  type FinanceAdAccount,
  type FinanceCurrency,
  type FinanceEntry,
  type FinanceEntryStatus,
  type FinanceResource,
  type FinanceSection,
  type VaultCategory,
  type VaultField,
  type VaultItem,
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

const VAULT_CATEGORY_META: Record<
  VaultCategory,
  { label: string; icon: typeof KeyRound; tint: string }
> = {
  credential: {
    label: 'Учётная запись',
    icon: KeyRound,
    tint: 'bg-primary/10 text-primary',
  },
  server: { label: 'Сервер', icon: Server, tint: 'bg-success/15 text-success' },
  account: { label: 'Аккаунт', icon: User, tint: 'bg-primary/10 text-primary' },
  social: {
    label: 'Соцсеть / ник',
    icon: AtSign,
    tint: 'bg-warning/15 text-warning',
  },
  payment: {
    label: 'Счёт / оплата',
    icon: CreditCard,
    tint: 'bg-success/15 text-success',
  },
  email: { label: 'Почта', icon: Mail, tint: 'bg-primary/10 text-primary' },
  domain: { label: 'Домен', icon: Globe, tint: 'bg-warning/15 text-warning' },
  api_key: {
    label: 'API-ключ',
    icon: TerminalSquare,
    tint: 'bg-destructive/10 text-destructive',
  },
  database: {
    label: 'База данных',
    icon: Database,
    tint: 'bg-success/15 text-success',
  },
  other: {
    label: 'Другое',
    icon: FileText,
    tint: 'bg-muted text-muted-foreground',
  },
}

async function copyToClipboard(value: string, label: string): Promise<void> {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    toast.success(`${label} скопирован${label.endsWith('а') ? 'а' : ''}`)
  } catch {
    toast.error('Не удалось скопировать')
  }
}

/** Cryptographically strong password for the generator button. */
function generatePassword(length = 20): string {
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+'
  const arr = new Uint32Array(length)
  crypto.getRandomValues(arr)
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet[arr[i] % alphabet.length]
  return out
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

/* ------------------------------------------------------------------ */
/* Единая валюта отображения — USD                                    */
/* ------------------------------------------------------------------ */

/** Курсы (USD за 1 единицу валюты) на текущий рендер. */
const RatesContext = createContext<UsdRates>(DEFAULT_USD_RATES)

function useRates(): UsdRates {
  return useContext(RatesContext)
}

/** Отформатировать сумму в USD. */
function formatUsd(amount: number): string {
  const n = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount)
  return `${n} $`
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

/** Дата и время для полного ISO-таймстампа (например, момент синхронизации). */
function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
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

/**
 * Метрики кабинета в USD. Пополнения и расход хранятся в валюте кабинета
 * (`a.currency`) и приводятся к USD по текущему курсу `rates`.
 */
function accountMetrics(a: FinanceAdAccount, rates: UsdRates): AccountMetrics {
  const topupsNative = a.topups.reduce((s, t) => s + t.amount, 0)
  // Метрики берём из единого источника: данные Яндекса (если интеграция включена)
  // или сумма ручных снимков, поверх которых применяются корректировки god-страницы.
  const {
    impressions,
    clicks,
    leads,
    spend: spendNative,
  } = adEffectiveMetrics(a)
  const topups = toUsd(topupsNative, a.currency, rates)
  const spend = toUsd(spendNative, a.currency, rates)
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

/** Итог по кабинетам в USD (единая валюта отображения). */
interface UsdTotals {
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
  totals: UsdTotals
  lowBalance: FinanceAdAccount[]
}

function summarizeAds(
  accounts: FinanceAdAccount[],
  rates: UsdRates,
): ResourceAdSummary {
  let leads = 0
  let clicks = 0
  let impressions = 0
  let activeAccounts = 0
  const totals: UsdTotals = { topups: 0, spend: 0, balance: 0, leads: 0 }
  const lowBalance: FinanceAdAccount[] = []

  for (const a of accounts) {
    const m = accountMetrics(a, rates)
    leads += m.leads
    clicks += m.clicks
    impressions += m.impressions
    if (a.status === 'active') activeAccounts += 1

    totals.topups += m.topups
    totals.spend += m.spend
    totals.balance += m.balance
    totals.leads += m.leads

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
    totals,
    lowBalance,
  }
}

/* ================================================================== */
/* Source sub-tab card                                                 */
/* ================================================================== */

/**
 * Крупная масштабируемая «карта-вкладка» источника вместо сжатых чипов.
 * Иконка + название + живая метрика (лиды / кабинеты / расход / секреты).
 * Построена поверх shadcn TabsTrigger, поэтому переключение и доступность
 * работают штатно, а сетка в TabsList тянется на всю ширину.
 */
function SourceTabCard({
  value,
  active,
  icon: Icon,
  label,
  stat,
}: {
  value: string
  active: boolean
  icon: LucideIcon
  label: string
  stat: string
}) {
  return (
    <TabsTrigger
      value={value}
      className={cn(
        'flex h-auto flex-col items-start gap-2 rounded-xl border p-3 text-left transition-colors sm:p-4',
        'data-[state=active]:border-primary data-[state=active]:bg-primary/5 data-[state=active]:shadow-none',
        active
          ? 'border-primary bg-primary/5'
          : 'border-border bg-card hover:bg-muted/50',
      )}
    >
      <span
        className={cn(
          'flex size-9 items-center justify-center rounded-lg',
          active
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-4.5" />
      </span>
      <span className="flex flex-col">
        <span
          className={cn(
            'text-sm font-semibold',
            active ? 'text-foreground' : 'text-foreground/90',
          )}
        >
          {label}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {stat}
        </span>
      </span>
    </TabsTrigger>
  )
}

/* ================================================================== */
/* Table controls types                                                */
/* ================================================================== */

type SortField = 'date' | 'title' | 'amount' | 'status'
type SortDir = 'asc' | 'desc'
type StatusFilter = 'all' | FinanceEntryStatus
type SubTab = 'overview' | 'ads' | 'expenses' | 'vault'

/* ================================================================== */
/* Main                                                                */
/* ================================================================== */

export function FinanceAdmin({
  resources,
  sections,
  entries,
  adAccounts,
  vaultItems,
  encryptionReady,
  rates,
  resourceLeads,
}: {
  resources: FinanceResource[]
  sections: FinanceSection[]
  entries: FinanceEntry[]
  adAccounts: FinanceAdAccount[]
  vaultItems: VaultItem[]
  encryptionReady: boolean
  rates: UsdRates
  /**
   * Реальные лиды по источнику: distinct входящих обращений из привязанных
   * каналов (resourceId → число). Это заменяет фейковые «лиды» из статистики
   * кабинетов. Рекламные лиды/CPL остаются отдельно во вкладке «Реклама».
   */
  resourceLeads?: Record<string, number>
}) {
  const [pending, startTransition] = useTransition()
  const [view, setView] = useState<'dashboard' | 'resource'>('dashboard')
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
  const [vaultDialog, setVaultDialog] = useState<
    | { mode: 'create'; resourceId: string }
    | { mode: 'edit'; item: VaultItem }
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
  const resourceVaultItems = useMemo(
    () =>
      activeResource
        ? vaultItems.filter((v) => v.resourceId === activeResource.id)
        : [],
    [vaultItems, activeResource],
  )

  // Реальные лиды источника — из обращений по привязанным каналам (приходят с
  // сервера). Больше НЕ берём из статистики рекламных кабинетов: то число ни к
  // чему реальному не привязано и жило само по себе.
  const leadCountByResource = useMemo(() => {
    const map = new Map<string, number>()
    for (const [id, n] of Object.entries(resourceLeads ?? {})) {
      map.set(id, n)
    }
    return map
  }, [resourceLeads])

  /* ---------------- Back bar (resource view only) ---------------- */

  const backBar = (
    <button
      type="button"
      onClick={() => setView('dashboard')}
      className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      Назад к учёту
    </button>
  )

  /* ---------------- Empty (no resources) ---------------- */

  if (!activeResource) {
    return (
      <RatesContext.Provider value={rates}>
        <div className="flex flex-col gap-4">
          <EmptyState
            icon={Wallet}
            title="Пока нет источников лидов"
            description="Добавьте первый источник (например, site.com), чтобы вести рекламные кабинеты и расходы."
            action={
              <Button
                className="gap-1.5"
                onClick={() => setResourceDialog({ mode: 'create' })}
              >
                <Plus className="size-4" /> Новый источник лидов
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
      </RatesContext.Provider>
    )
  }

  if (view === 'dashboard') {
    return (
      <RatesContext.Provider value={rates}>
        <div className="flex flex-col gap-5">
          <GlobalDashboard
            resources={resources}
            adAccounts={adAccounts}
            entries={entries}
            vaultItems={vaultItems}
            leadCountByResource={leadCountByResource}
            onOpenResource={(id, tab) => {
              setResourceId(id)
              setSubTab(tab ?? 'overview')
              setView('resource')
            }}
            onCreateResource={() => setResourceDialog({ mode: 'create' })}
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
      </RatesContext.Provider>
    )
  }

  const adSummary = summarizeAds(resourceAccounts, rates)

  // Сумма расходов источника в USD — для подписи на вкладке «Расходы».
  // Записи уже хранятся в USD (origAmount переводится при вводе); в этом UI все
  // записи — расходы, поэтому суммируем amount по всем.
  const resourceExpenseTotal = resourceEntries.reduce(
    (s, e) => s + e.amount,
    0,
  )

  return (
    <RatesContext.Provider value={rates}>
    <div className="flex flex-col gap-5">
      {backBar}

      {/* Resource header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">
            {activeResource.name}
          </h2>
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
            <Pencil className="size-4" /> Источник
          </Button>
        </div>
      </div>

      {activeResource.description ? (
        <p className="-mt-2 text-sm text-muted-foreground">
          {activeResource.description}
        </p>
      ) : null}

      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as SubTab)}>
        <TabsList className="grid h-auto w-full grid-cols-2 gap-2 bg-transparent p-0 sm:grid-cols-4">
          <SourceTabCard
            value="overview"
            active={subTab === 'overview'}
            icon={BarChart3}
            label="Обзор"
            stat={`${formatInt(leadCountByResource.get(activeResource.id) ?? 0)} лид.`}
          />
          <SourceTabCard
            value="ads"
            active={subTab === 'ads'}
            icon={Wallet}
            label="Реклама"
            stat={`${adSummary.activeAccounts}/${adSummary.totalAccounts} кабин.`}
          />
          <SourceTabCard
            value="expenses"
            active={subTab === 'expenses'}
            icon={TrendingDown}
            label="Расходы"
            stat={formatUsd(resourceExpenseTotal)}
          />
          <SourceTabCard
            value="vault"
            active={subTab === 'vault'}
            icon={Vault}
            label="Хранилище"
            stat={
              resourceVaultItems.length > 0
                ? `${formatInt(resourceVaultItems.length)} секр.`
                : 'пусто'
            }
          />
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
            onSync={(account) => run(() => syncAdAccountAction(account.id))}
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

        {/* ---------------- Vault ---------------- */}
        <TabsContent value="vault" className="mt-4">
          <VaultPanel
            items={resourceVaultItems}
            encryptionReady={encryptionReady}
            pending={pending}
            resourceName={activeResource.name}
            onImport={(rows) =>
              run(() => importVaultItemsAction(activeResource.id, rows))
            }
            onAdd={() =>
              setVaultDialog({ mode: 'create', resourceId: activeResource.id })
            }
            onEdit={(item) => setVaultDialog({ mode: 'edit', item })}
            onToggleFavorite={(item) =>
              run(() => toggleVaultFavoriteAction(item.id, !item.favorite))
            }
            onDelete={(item) =>
              setConfirm({
                title: 'Удалить запись?',
                description: `«${item.title}» и все её секреты будут удалены безвозвратно.`,
                onConfirm: () =>
                  run(() => deleteVaultItemAction(item.id), () =>
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

      <VaultDialog
        state={vaultDialog}
        pending={pending}
        encryptionReady={encryptionReady}
        onClose={() => setVaultDialog(null)}
        onCreate={(rid, fd) =>
          run(() => createVaultItemAction(rid, fd), () => setVaultDialog(null))
        }
        onUpdate={(id, fd) =>
          run(() => updateVaultItemAction(id, fd), () => setVaultDialog(null))
        }
      />

      <ConfirmDialog
        state={confirm}
        pending={pending}
        onClose={() => setConfirm(null)}
      />
    </div>
    </RatesContext.Provider>
  )
}

/* ================================================================== */
/* Global dashboard (all resources)                                    */
/* ================================================================== */

interface CabinetCard {
  account: FinanceAdAccount
  resourceId: string
  resourceName: string
  balance: number
  topups: number
  spend: number
  leads: number
  blocked: boolean
}

interface SourceRow {
  resource: FinanceResource
  leads: number
  balance: number
  activeAccounts: number
  totalAccounts: number
}

/** Статусы, при которых кабинет считаем заблокированным/проблемным. */
const BLOCKED_AD_STATUSES = new Set<AdStatus>(['banned', 'no_funds'])

function GlobalDashboard({
  resources,
  adAccounts,
  entries,
  vaultItems,
  leadCountByResource,
  onOpenResource,
  onCreateResource,
}: {
  resources: FinanceResource[]
  adAccounts: FinanceAdAccount[]
  entries: FinanceEntry[]
  vaultItems: VaultItem[]
  leadCountByResource: Map<string, number>
  onOpenResource: (id: string, tab?: SubTab) => void
  onCreateResource: () => void
}) {
  const rates = useRates()

  const { cabinets, sources } = useMemo(() => {
    const nameById = new Map(resources.map((r) => [r.id, r.name]))
    const cabinets: CabinetCard[] = []
    const sourceAgg = new Map<string, { balance: number; active: number; total: number }>()

    for (const a of adAccounts) {
      if (a.status === 'archived') continue
      const m = accountMetrics(a, rates)
      cabinets.push({
        account: a,
        resourceId: a.resourceId,
        resourceName: nameById.get(a.resourceId) ?? '—',
        balance: m.balance,
        topups: m.topups,
        spend: m.spend,
        leads: m.leads,
        blocked: BLOCKED_AD_STATUSES.has(a.status),
      })
      const agg = sourceAgg.get(a.resourceId) ?? { balance: 0, active: 0, total: 0 }
      agg.balance += m.balance
      agg.total += 1
      if (a.status === 'active') agg.active += 1
      sourceAgg.set(a.resourceId, agg)
    }

    // Проблемные кабинеты — вперёд, затем по возрастанию баланса.
    cabinets.sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? -1 : 1
      return a.balance - b.balance
    })

    const sources: SourceRow[] = resources.map((resource) => {
      const agg = sourceAgg.get(resource.id)
      return {
        resource,
        leads: leadCountByResource.get(resource.id) ?? 0,
        balance: agg?.balance ?? 0,
        activeAccounts: agg?.active ?? 0,
        totalAccounts: agg?.total ?? 0,
      }
    })
    sources.sort((a, b) => b.leads - a.leads)

    return { cabinets, sources }
  }, [resources, adAccounts, rates, leadCountByResource])

  return (
    <div className="flex flex-col gap-6">
      {/* Балансы подключённых кабинетов */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Wallet className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Балансы подключённых кабинетов</h3>
          <span className="text-xs text-muted-foreground">· в USD</span>
        </div>
        {cabinets.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Пока нет подключённых кабинетов. Откройте источник лидов и добавьте
            рекламный кабинет.
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cabinets.map((c) => {
              const meta = AD_STATUS_META[c.account.status]
              return (
                <button
                  key={c.account.id}
                  type="button"
                  onClick={() => onOpenResource(c.resourceId, 'ads')}
                  className={cn(
                    'group flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors',
                    c.blocked
                      ? 'border-destructive/50 bg-destructive/5 hover:bg-destructive/10'
                      : 'border-border bg-card hover:bg-muted/50',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{c.account.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {c.resourceName}
                      </p>
                    </div>
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                        meta.className,
                      )}
                    >
                      <span className={cn('size-1.5 rounded-full', meta.dot)} />
                      {meta.label}
                    </span>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Баланс
                    </p>
                    <p
                      className={cn(
                        'text-2xl font-semibold tabular-nums',
                        c.balance <= 0 ? 'text-destructive' : 'text-foreground',
                      )}
                    >
                      {formatUsd(c.balance)}
                    </p>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Пополнено {formatUsd(c.topups)}</span>
                    <span className="inline-flex items-center gap-1 text-primary opacity-0 transition-opacity group-hover:opacity-100">
                      Подробнее <ArrowRight className="size-3.5" />
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </section>

      {/* Источники лидов */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Layers className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Источники лидов</h3>
          </div>
          <Button size="sm" className="gap-1.5" onClick={onCreateResource}>
            <Plus className="size-4" /> Новый источник лидов
          </Button>
        </div>
        {sources.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Пока нет источников лидов.
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sources.map((s) => (
              <button
                key={s.resource.id}
                type="button"
                onClick={() => onOpenResource(s.resource.id)}
                className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{s.resource.name}</span>
                  {s.resource.archived ? (
                    <Archive className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : null}
                </div>
                <div className="flex items-end justify-between gap-2">
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Лиды
                    </p>
                    <p className="text-xl font-semibold tabular-nums">
                      {formatInt(s.leads)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Баланс
                    </p>
                    <p
                      className={cn(
                        'text-sm font-semibold tabular-nums',
                        s.totalAccounts > 0 && s.balance <= 0
                          ? 'text-destructive'
                          : 'text-foreground',
                      )}
                    >
                      {s.totalAccounts > 0 ? formatUsd(s.balance) : '—'}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Кабинетов: {s.activeAccounts}/{s.totalAccounts}
                </p>
              </button>
            ))}
          </div>
        )}
      </section>
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
  const rates = useRates()
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

      {/* Balance (USD) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Баланс рекламы</h3>
          <Button variant="ghost" size="sm" onClick={onGoAds}>
            Кабинеты <ChevronRight className="size-4" />
          </Button>
        </div>
        {summary.totalAccounts === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Ещё нет рекламных кабинетов.
          </Card>
        ) : (
          (() => {
            const t = summary.totals
            const cpl = t.leads > 0 ? t.spend / t.leads : null
            const low = t.balance <= 0
            return (
              <Card className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    Общий баланс
                  </span>
                  <Wallet className="size-4 text-muted-foreground" />
                </div>
                <div
                  className={cn(
                    'mt-2 text-2xl font-semibold tabular-nums',
                    low ? 'text-destructive' : 'text-foreground',
                  )}
                >
                  {formatUsd(t.balance)}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                  <Metric label="Пополнено" value={formatUsd(t.topups)} />
                  <Metric label="Расход" value={formatUsd(t.spend)} />
                  <Metric label="Лиды" value={formatInt(t.leads)} />
                  <Metric
                    label="CPL"
                    value={cpl == null ? '—' : formatUsd(cpl)}
                  />
                </div>
              </Card>
            )
          })()
        )}
      </div>

      {/* Accounts quick list */}
      {accounts.length > 0 ? (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Кабинеты</h3>
          <Card className="divide-y divide-border p-0">
            {accounts.map((a) => {
              const m = accountMetrics(a, rates)
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
                      {formatUsd(m.balance)}
                    </span>
                  </div>
                  <div className="tabular-nums text-sm text-muted-foreground">
                    {formatInt(m.leads)} лид. ·{' '}
                    {m.cpl === Number.POSITIVE_INFINITY
                      ? 'CPL —'
                      : `CPL ${formatUsd(m.cpl)}`}
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
            value={formatUsd(expenseTotal)}
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
  onSync,
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
  onSync: (a: FinanceAdAccount) => void
  onDeleteAccount: (a: FinanceAdAccount) => void
  onDeleteTopup: (id: string) => void
  onDeleteStat: (id: string) => void
}) {
  const [layout, setLayout] = useState<'cards' | 'table'>('cards')
  const rates = useRates()

  const lowBalance = accounts.filter(
    (a) =>
      a.status !== 'archived' &&
      accountMetrics(a, rates).balance <= 0 &&
      accountMetrics(a, rates).topups > 0,
  )
  const hasStats = accounts.some((a) => a.stats.length > 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {accounts.length} кабинет(ов)
        </p>
        <div className="flex items-center gap-2">
          {accounts.length > 0 ? (
            <div className="inline-flex rounded-lg border border-border p-0.5">
              <button
                type="button"
                onClick={() => setLayout('cards')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition-colors',
                  layout === 'cards'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Layers className="size-4" /> Карточки
              </button>
              <button
                type="button"
                onClick={() => setLayout('table')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition-colors',
                  layout === 'table'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Table2 className="size-4" /> Таблица
              </button>
            </div>
          ) : null}
          <Button className="gap-1.5" onClick={onAdd}>
            <Plus className="size-4" /> Кабинет
          </Button>
        </div>
      </div>

      {lowBalance.length > 0 ? (
        <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-3.5">
          <TrendingDown className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="text-sm">
            <p className="font-medium text-destructive">
              Заканчивается баланс: {lowBalance.length}
            </p>
            <p className="text-muted-foreground">
              {lowBalance.map((a) => a.name).join(', ')} — пополните, чтобы
              реклама не остановилась.
            </p>
          </div>
        </Card>
      ) : null}

      {hasStats ? (
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <BarChart3 className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Динамика лидов и кликов</h3>
          </div>
          <AdsTrendChart accounts={accounts} />
        </Card>
      ) : null}

      {accounts.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="Нет рекламных кабинетов"
          description="Добавьте кабинет (Яндекс Директ, Google Ads и т.д.), затем пополняйте баланс и вносите статисти��у."
          action={
            <Button className="gap-1.5" onClick={onAdd}>
              <Plus className="size-4" /> Добавить кабинет
            </Button>
          }
        />
      ) : layout === 'table' ? (
        <AdsSummaryTable accounts={accounts} onEdit={onEdit} onTopup={onTopup} />
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
              onSync={() => onSync(a)}
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

function AdsSummaryTable({
  accounts,
  onEdit,
  onTopup,
}: {
  accounts: FinanceAdAccount[]
  onEdit: (a: FinanceAdAccount) => void
  onTopup: (a: FinanceAdAccount) => void
}) {
  const rates = useRates()
  return (
    <Card className="overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Кабинет</th>
              <th className="px-4 py-2.5 text-right font-medium">Баланс</th>
              <th className="px-4 py-2.5 text-right font-medium">Расход</th>
              <th className="px-4 py-2.5 text-right font-medium">Лиды</th>
              <th className="px-4 py-2.5 text-right font-medium">CPL</th>
              <th className="px-4 py-2.5 text-right font-medium">CTR</th>
              <th className="px-4 py-2.5 text-right font-medium">CR</th>
              <th className="px-4 py-2.5 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => {
              const m = accountMetrics(a, rates)
              return (
                <tr
                  key={a.id}
                  className="border-b border-border/60 transition-colors last:border-0 hover:bg-muted/50"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'size-2 shrink-0 rounded-full',
                          AD_STATUS_META[a.status].dot,
                        )}
                      />
                      <button
                        type="button"
                        onClick={() => onEdit(a)}
                        className="truncate font-medium hover:underline"
                      >
                        {a.name}
                      </button>
                      <span className="text-xs text-muted-foreground">
                        {PLATFORM_META[a.platform]}
                      </span>
                    </div>
                  </td>
                  <td
                    className={cn(
                      'px-4 py-3 text-right font-semibold tabular-nums',
                      m.balance <= 0 && 'text-destructive',
                    )}
                  >
                    {formatUsd(m.balance)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {formatUsd(m.spend)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatInt(m.leads)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {m.cpl === Number.POSITIVE_INFINITY
                      ? '—'
                      : formatUsd(m.cpl)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {formatPct(m.ctr)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {formatPct(m.cr)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => onTopup(a)}
                    >
                      <Plus className="size-3.5" /> Пополнить
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function AdAccountCard({
  account,
  pending,
  onEdit,
  onTopup,
  onStat,
  onSync,
  onDelete,
  onDeleteTopup,
  onDeleteStat,
}: {
  account: FinanceAdAccount
  pending: boolean
  onEdit: () => void
  onTopup: () => void
  onStat: () => void
  onSync: () => void
  onDelete: () => void
  onDeleteTopup: (id: string) => void
  onDeleteStat: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rates = useRates()
  const m = accountMetrics(account, rates)
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
          {account.externalEnabled ? (
            <Badge
              variant="outline"
              className="mt-1.5 gap-1 border-primary/30 bg-primary/5 text-primary"
            >
              <LinkIcon className="size-3" />
              Яндекс.Директ
            </Badge>
          ) : null}
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
          {formatUsd(m.balance)}
        </div>
        <div className="mt-1 text-xs text-muted-foreground tabular-nums">
          Пополнено {formatUsd(m.topups)} · Расход{' '}
          {formatUsd(m.spend)}
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
              : formatUsd(m.cpl)
          }
        />
      </div>

      {account.note ? (
        <p className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {account.note}
        </p>
      ) : null}

      {/* Sync status (integration) */}
      {account.externalEnabled ? (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          {account.syncError ? (
            <>
              <AlertTriangle className="size-3.5 text-destructive" />
              <span className="text-destructive">
                Ошибка синхронизации: {account.syncError}
              </span>
            </>
          ) : account.lastSyncAt ? (
            <>
              <RefreshCw className="size-3.5" />
              <span>Синхронизировано {formatDateTime(account.lastSyncAt)}</span>
            </>
          ) : (
            <>
              <AlertTriangle className="size-3.5" />
              <span>Ещё не синхронизировано — нажмите «Обновить».</span>
            </>
          )}
        </div>
      ) : null}

      {/* Actions */}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" className="gap-1.5" onClick={onTopup}>
          <CreditCard className="size-4" /> Пополнить
        </Button>
        {account.externalEnabled ? (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={onSync}
            disabled={pending}
          >
            <RefreshCw
              className={cn('size-4', pending && 'animate-spin')}
            />
            Обновить
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={onStat}
          >
            <BarChart3 className="size-4" /> Статистика
          </Button>
        )}
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
                        +{formatUsd(toUsd(t.amount, account.currency, rates))}
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
                          −{formatUsd(toUsd(st.spend, account.currency, rates))}
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
                {formatUsd(totalFor(s.id))}
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
                  {formatUsd(sectionTotal)}
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
          {formatUsd(entry.amount)}
          {entry.origCurrency !== 'USD' && entry.origCurrency !== 'USDT' ? (
            <div className="text-xs font-normal text-muted-foreground">
              {formatMoney(entry.origAmount, entry.origCurrency)}
            </div>
          ) : null}
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
              {editing ? 'Изменить источник лидов' : 'Новый источник лидов'}
            </DialogTitle>
            <DialogDescription>
              Источник лидов — это площадка (например, site.com), внутри которой
              вы ведёте рекламные кабинеты и расходы. Все суммы учитываются в USD.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="res-name">Название</Label>
              <Input
                id="res-name"
                name="name"
                defaultValue={editing?.name ?? ''}
                placeholder="Например, site.com или «Лендинг Весна»"
                autoFocus
                required
              />
              <p className="text-xs text-muted-foreground">
                Короткое узнаваемое имя, по которому вы найдёте источник в списке.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="res-desc">Описание</Label>
              <Textarea
                id="res-desc"
                name="description"
                defaultValue={editing?.description ?? ''}
                placeholder="Необязательно: что это за источник, откуда идут лиды, кто ведёт"
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                Пара слов для контекста — поможет вспомнить детали позже.
              </p>
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
  const [externalEnabled, setExternalEnabled] = useState(false)
  const [platform, setPlatform] = useState<AdPlatform>('yandex_direct')

  // This reusable dialog remains mounted; a changed entity must reset its draft.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (state?.mode === 'edit') {
      setExternalEnabled(state.account.externalEnabled)
      setPlatform(state.account.platform)
    } else if (state?.mode === 'create') {
      setExternalEnabled(false)
      setPlatform('yandex_direct')
    }
  }, [state])
  /* eslint-enable react-hooks/set-state-in-effect */

  const canIntegrate = platform === 'yandex_direct'

  return (
    <Dialog open={state != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
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
              <Label htmlFor="acc-name">Н��звание</Label>
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
                  value={platform}
                  onValueChange={(v) => setPlatform(v as AdPlatform)}
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

            {/* Прямая интеграция с Яндекс.Директом */}
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <LinkIcon className="size-4 text-muted-foreground" />
                    <Label
                      htmlFor="acc-external"
                      className="cursor-pointer font-medium"
                    >
                      Интеграция с Яндекс.Директом
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {canIntegrate
                      ? 'Статистика (показы, клики, лиды, расход) подтягивается автоматически. Пополнения остаются ручными.'
                      : 'Доступно только для площадки «Яндекс Директ».'}
                  </p>
                </div>
                <Switch
                  id="acc-external"
                  name="externalEnabled"
                  checked={externalEnabled}
                  onCheckedChange={setExternalEnabled}
                  disabled={!canIntegrate}
                />
              </div>

              {externalEnabled && canIntegrate ? (
                <div className="mt-3 space-y-3 border-t border-border pt-3">
                  <div className="space-y-2">
                    <Label htmlFor="acc-yandex-login">Логин клиента (необяз.)</Label>
                    <Input
                      id="acc-yandex-login"
                      name="yandexLogin"
                      defaultValue={editing?.yandexLogin ?? ''}
                      placeholder="agency-client-login"
                    />
                    <p className="text-xs text-muted-foreground">
                      Для агентских аккаунтов — логин управляемого клиента.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="acc-yandex-token">OAuth-токен</Label>
                    <Input
                      id="acc-yandex-token"
                      name="yandexToken"
                      type="password"
                      autoComplete="off"
                      placeholder={
                        editing?.hasToken
                          ? '•••••••• (сохранён — оставьте пустым, чтобы не менять)'
                          : 'y0_AgAAAA...'
                      }
                      required={!editing?.hasToken}
                    />
                    <p className="text-xs text-muted-foreground">
                      Токен хранится в зашифрованном виде и не отображается.
                    </p>
                  </div>
                </div>
              ) : null}
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
  const rates = useRates()

  // Локальное состояние суммы/валюты для живого превью в USD.
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<FinanceCurrency>('USD')

  // Сброс значений при каждом открытии диалога под конкретную запись.
  useEffect(() => {
    if (!state) return
    if (state.mode === 'edit') {
      setAmount(String(state.entry.origAmount || state.entry.amount || ''))
      setCurrency(state.entry.origCurrency ?? 'USD')
    } else {
      setAmount('')
      setCurrency('USD')
    }
  }, [state])

  const parsedAmount = Number.parseFloat(amount.replace(',', '.'))
  const usdPreview =
    Number.isFinite(parsedAmount) && parsedAmount > 0
      ? toUsd(parsedAmount, currency, rates)
      : null

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
            <DialogDescription>
              Сумму можно ввести в любой валюте — она сразу переводится в USD по
              текущему курсу и фиксируется.
            </DialogDescription>
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
            <div className="space-y-2">
              <Label htmlFor="entry-vendor">Контрагент</Label>
              <Input
                id="entry-vendor"
                name="vendor"
                defaultValue={editing?.vendor ?? ''}
                placeholder="Кому платим"
              />
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <div className="space-y-2">
                <Label htmlFor="entry-amount">Сумма</Label>
                <Input
                  id="entry-amount"
                  name="amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="entry-currency">Валюта</Label>
                <CurrencySelect
                  name="currency"
                  value={currency}
                  onValueChange={(v) => setCurrency(v)}
                />
              </div>
            </div>
            {usdPreview != null && currency !== 'USD' && currency !== 'USDT' ? (
              <p className="-mt-1 text-sm text-muted-foreground">
                ≈ <span className="font-semibold text-foreground">{formatUsd(usdPreview)}</span>{' '}
                по курсу на сегодня
              </p>
            ) : null}
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
  value,
  onValueChange,
}: {
  name: string
  defaultValue?: FinanceCurrency
  value?: FinanceCurrency
  onValueChange?: (v: FinanceCurrency) => void
}) {
  return (
    <Select
      name={name}
      defaultValue={defaultValue}
      value={value}
      onValueChange={
        onValueChange
          ? (v) => onValueChange(v as FinanceCurrency)
          : undefined
      }
    >
      <SelectTrigger className="w-[110px]">
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

/* ================================================================== */
/* Vault panel (Хранилище)                                             */
/* ================================================================== */

function VaultPanel({
  items,
  encryptionReady,
  pending,
  resourceName,
  onAdd,
  onEdit,
  onToggleFavorite,
  onDelete,
  onImport,
}: {
  items: VaultItem[]
  encryptionReady: boolean
  pending: boolean
  resourceName: string
  onAdd: () => void
  onEdit: (item: VaultItem) => void
  onToggleFavorite: (item: VaultItem) => void
  onDelete: (item: VaultItem) => void
  onImport: (rows: ParsedVaultRow[]) => void
}) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<'all' | VaultCategory>('all')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const reusedSecrets = useMemo(() => findReusedSecrets(items), [items])

  const countByCategory = useMemo(() => {
    const map = new Map<VaultCategory, number>()
    for (const it of items) map.set(it.category, (map.get(it.category) ?? 0) + 1)
    return map
  }, [items])

  function slug(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9а-я]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'vault'
    )
  }

  async function handleFile(file: File) {
    try {
      const text = await file.text()
      const rows = parseVaultFile(file.name, text)
      if (rows.length === 0) {
        toast.error('В файле не найдено записей.')
        return
      }
      onImport(rows)
    } catch {
      toast.error('Не удалось прочитать файл. Ожидается CSV или JSON.')
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((it) => {
      if (category !== 'all' && it.category !== category) return false
      if (!q) return true
      const hay = [
        it.title,
        it.login,
        it.url,
        it.note,
        VAULT_CATEGORY_META[it.category].label,
        ...it.tags,
        ...it.fields.map((f) => f.label),
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [items, search, category])

  const activeCategories = VAULT_CATEGORIES.filter(
    (c) => (countByCategory.get(c) ?? 0) > 0,
  )

  return (
    <div className="flex flex-col gap-4">
      {/* Security banner */}
      {encryptionReady ? (
        <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          <ShieldCheck className="size-4 shrink-0" />
          <span className="text-pretty">
            Пароли и секреты шифруются AES-256-GCM — в базе хранится только
            шифртекст.
          </span>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span className="text-pretty">
            {'Ключ шифрования не задан. Задайте переменную '}
            <code className="rounded bg-warning/20 px-1 font-mono text-[13px]">
              ENCRYPTION_KEY
            </code>
            {' (openssl rand -hex 32), чтобы сохранять пароли и секреты.'}
          </span>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по названию, логину, тегам…"
            className="pl-9"
            aria-label="Поиск по хранилищу"
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.json,text/csv,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleFile(file)
              e.target.value = ''
            }}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  disabled={items.length === 0}
                  aria-label="Экспорт хранилища"
                  title="Экспорт"
                >
                  <Download className="size-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() =>
                  downloadText(
                    `${slug(resourceName)}-vault.json`,
                    toJSON(items),
                    'application/json',
                  )
                }
              >
                Экспорт в JSON
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  downloadText(
                    `${slug(resourceName)}-vault.csv`,
                    toCSV(items),
                    'text/csv',
                  )
                }
              >
                Экспорт в CSV
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            disabled={pending}
            aria-label="Импорт в хранилище"
            title="Импорт из CSV / JSON"
          >
            <Upload className="size-4" />
          </Button>
          <Button className="gap-1.5" onClick={onAdd}>
            <Plus className="size-4" /> Добавить запись
          </Button>
        </div>
      </div>

      {/* Category filter chips */}
      {activeCategories.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <VaultChip
            active={category === 'all'}
            label="Все"
            count={items.length}
            onClick={() => setCategory('all')}
          />
          {activeCategories.map((c) => {
            const meta = VAULT_CATEGORY_META[c]
            const Icon = meta.icon
            return (
              <VaultChip
                key={c}
                active={category === c}
                label={meta.label}
                count={countByCategory.get(c) ?? 0}
                icon={<Icon className="size-3.5" />}
                onClick={() => setCategory(c)}
              />
            )
          })}
        </div>
      ) : null}

      {/* Content */}
      {items.length === 0 ? (
        <EmptyState
          icon={Vault}
          title="Хранилище пустое"
          description="Соберите здесь все данные проекта: учётные записи, сервера, аккаунты, ники, счета и оплаты. Секреты шифруются."
          action={
            <Button className="gap-1.5" onClick={onAdd}>
              <Plus className="size-4" /> Добавить первую запись
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          Ничего не найдено. Измените запрос или категорию.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((item) => (
            <VaultCard
              key={item.id}
              item={item}
              pending={pending}
              reused={!!item.secret && reusedSecrets.has(item.secret)}
              onEdit={() => onEdit(item)}
              onToggleFavorite={() => onToggleFavorite(item)}
              onDelete={() => onDelete(item)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function VaultChip({
  active,
  label,
  count,
  icon,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  icon?: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-card text-foreground hover:bg-muted',
      )}
    >
      {icon}
      <span>{label}</span>
      <span
        className={cn(
          'rounded-full px-1.5 text-xs tabular-nums',
          active ? 'bg-primary-foreground/20' : 'bg-muted text-muted-foreground',
        )}
      >
        {count}
      </span>
    </button>
  )
}

/** One masked/copyable row inside a vault card. */
function VaultRow({
  icon: Icon,
  label,
  value,
  secret = false,
  href,
}: {
  icon: typeof KeyRound
  label: string
  value: string
  secret?: boolean
  href?: string
}) {
  const [show, setShow] = useState(false)

  // Auto-hide a revealed secret after 20s so it never lingers on screen.
  useEffect(() => {
    if (!show || !secret) return
    const t = setTimeout(() => setShow(false), 20000)
    return () => clearTimeout(t)
  }, [show, secret])

  if (!value) return null
  const masked = secret && !show
  const display = masked ? '•'.repeat(Math.min(14, Math.max(8, value.length))) : value
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        {href && !masked ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate font-mono text-sm text-primary hover:underline"
          >
            {display}
          </a>
        ) : (
          <p className="truncate font-mono text-sm">{display}</p>
        )}
      </div>
      {secret ? (
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={show ? 'Скрыть' : 'Показать'}
        >
          {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      ) : null}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Открыть ссылку"
        >
          <ExternalLink className="size-3.5" />
        </a>
      ) : null}
      <button
        type="button"
        onClick={() => copyToClipboard(value, label)}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={`Скопировать: ${label}`}
      >
        <Copy className="size-3.5" />
      </button>
    </div>
  )
}

function VaultCard({
  item,
  pending,
  reused,
  onEdit,
  onToggleFavorite,
  onDelete,
}: {
  item: VaultItem
  pending: boolean
  reused?: boolean
  onEdit: () => void
  onToggleFavorite: () => void
  onDelete: () => void
}) {
  const meta = VAULT_CATEGORY_META[item.category]
  const Icon = meta.icon
  const url = item.url
    ? /^https?:\/\//i.test(item.url)
      ? item.url
      : `https://${item.url}`
    : undefined
  const strength = item.secret ? scorePassword(item.secret) : null
  const weak = strength != null && strength.score <= 1
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg',
            meta.tint,
          )}
        >
        <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h4 className="truncate font-medium leading-tight">{item.title}</h4>
            {weak ? (
              <span title="Слабый пароль">
                <ShieldAlert className="size-3.5 shrink-0 text-warning" />
              </span>
            ) : null}
            {reused ? (
              <span title="Пароль повторяется в другой записи">
                <AlertTriangle className="size-3.5 shrink-0 text-warning" />
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{meta.label}</p>
        </div>
        <button
          type="button"
          onClick={onToggleFavorite}
          disabled={pending}
          className={cn(
            'rounded p-1 transition-colors hover:bg-muted disabled:opacity-50',
            item.favorite
              ? 'text-warning'
              : 'text-muted-foreground hover:text-foreground',
          )}
          aria-label={item.favorite ? 'Открепить' : 'Закрепить'}
        >
          <Star
            className={cn('size-4', item.favorite && 'fill-current')}
          />
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <VaultRow icon={User} label="Логин" value={item.login} />
        <VaultRow icon={Lock} label="Секрет" value={item.secret} secret />
        <VaultRow icon={Globe} label="Ссылка / хост" value={item.url} href={url} />
        {item.fields.map((f, i) => (
          <VaultRow
            key={`${f.label}-${i}`}
            icon={f.secret ? KeyRound : FileText}
            label={f.label || 'Пол��'}
            value={f.value}
            secret={f.secret}
          />
        ))}
      </div>

      {strength != null ? <StrengthMeter strength={strength} compact /> : null}

      {item.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {item.tags.map((t) => (
            <Badge key={t} variant="outline" className="text-xs font-normal">
              {t}
            </Badge>
          ))}
        </div>
      ) : null}

      {item.note ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
          {item.note}
        </p>
      ) : null}

      <div className="mt-auto flex items-center gap-1 border-t border-border/60 pt-2">
        {item.login && item.secret ? (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() =>
              copyToClipboard(
                `${item.login}\t${item.secret}`,
                'Логин и пароль',
              )
            }
            title="Скопировать логин и пароль (через таб)"
          >
            <ClipboardCopy className="size-3.5" /> Логин+пароль
          </Button>
        ) : null}
        <div className="flex-1" />
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={onEdit}>
          <Pencil className="size-3.5" /> Изменить
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-destructive hover:text-destructive"
          onClick={onDelete}
          aria-label="Удалить"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </Card>
  )
}

function StrengthMeter({
  strength,
  compact = false,
}: {
  strength: PasswordStrength
  compact?: boolean
}) {
  const barTone =
    strength.tone === 'success'
      ? 'bg-success'
      : strength.tone === 'warning'
        ? 'bg-warning'
        : strength.tone === 'destructive'
          ? 'bg-destructive'
          : 'bg-muted-foreground/40'
  const textTone =
    strength.tone === 'success'
      ? 'text-success'
      : strength.tone === 'warning'
        ? 'text-warning'
        : strength.tone === 'destructive'
          ? 'text-destructive'
          : 'text-muted-foreground'
  return (
    <div className={cn('flex items-center gap-2', compact ? 'text-xs' : 'text-sm')}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-all', barTone)}
          style={{ width: `${strength.percent}%` }}
        />
      </div>
      <span className={cn('shrink-0 font-medium', textTone)}>
        {strength.label}
      </span>
    </div>
  )
}

function VaultDialog({
  state,
  pending,
  encryptionReady,
  onClose,
  onCreate,
  onUpdate,
}: {
  state:
    | { mode: 'create'; resourceId: string }
    | { mode: 'edit'; item: VaultItem }
    | null
  pending: boolean
  encryptionReady: boolean
  onClose: () => void
  onCreate: (resourceId: string, fd: FormData) => void
  onUpdate: (id: string, fd: FormData) => void
}) {
  const editing = state?.mode === 'edit' ? state.item : null

  const [category, setCategory] = useState<VaultCategory>('credential')
  const [title, setTitle] = useState('')
  const [login, setLogin] = useState('')
  const [secret, setSecret] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [url, setUrl] = useState('')
  const [note, setNote] = useState('')
  const [tags, setTags] = useState('')
  const [favorite, setFavorite] = useState(false)
  const [fields, setFields] = useState<VaultField[]>([])

  // This reusable dialog remains mounted; a changed vault item resets its draft.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!state) return
    if (state.mode === 'edit') {
      const it = state.item
      setCategory(it.category)
      setTitle(it.title)
      setLogin(it.login)
      setSecret(it.secret)
      setUrl(it.url)
      setNote(it.note)
      setTags(it.tags.join(', '))
      setFavorite(it.favorite)
      setFields(it.fields.map((f) => ({ ...f })))
    } else {
      setCategory('credential')
      setTitle('')
      setLogin('')
      setSecret('')
      setUrl('')
      setNote('')
      setTags('')
      setFavorite(false)
      setFields([])
    }
    setShowSecret(false)
  }, [state])
  /* eslint-enable react-hooks/set-state-in-effect */

  function updateField(index: number, patch: Partial<VaultField>) {
    setFields((prev) =>
      prev.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    )
  }

  function submit() {
    const fd = new FormData()
    fd.set('category', category)
    fd.set('title', title)
    fd.set('login', login)
    fd.set('secret', secret)
    fd.set('url', url)
    fd.set('note', note)
    fd.set('tags', tags)
    fd.set('favorite', favorite ? 'true' : 'false')
    fd.set(
      'fields',
      JSON.stringify(fields.filter((f) => f.label.trim() || f.value.trim())),
    )
    if (editing) onUpdate(editing.id, fd)
    else if (state?.mode === 'create') onCreate(state.resourceId, fd)
  }

  return (
    <Dialog open={state != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Изменить запись' : 'Новая запись в хранилище'}
            </DialogTitle>
            <DialogDescription>
              Данные привязаны к текущему ресурсу. Секреты шифруются перед
              сохранением.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="vault-category">Категория</Label>
                <Select
                  value={category}
                  onValueChange={(v) => setCategory(v as VaultCategory)}
                >
                  <SelectTrigger id="vault-category" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VAULT_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {VAULT_CATEGORY_META[c].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="vault-title">Название</Label>
                <Input
                  id="vault-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Например: cPanel хостинга"
                  autoFocus
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="vault-login">Логин / e-mail / ник / номер</Label>
              <Input
                id="vault-login"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                placeholder="admin@site.com"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="vault-secret">Пароль / токен / ключ</Label>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Input
                    id="vault-secret"
                    type={showSecret ? 'text' : 'password'}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder="••••••••"
                    className="pr-9 font-mono"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                    aria-label={showSecret ? 'Скрыть' : 'Показать'}
                  >
                    {showSecret ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    setSecret(generatePassword())
                    setShowSecret(true)
                  }}
                  aria-label="Сгенерировать пароль"
                  title="Сгенерировать надёжный пароль"
                >
                  <RefreshCw className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  disabled={!secret}
                  onClick={() => copyToClipboard(secret, 'Секрет')}
                  aria-label="Скопировать"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
              {secret ? <StrengthMeter strength={scorePassword(secret)} /> : null}
              {!encryptionReady ? (
                <p className="text-xs text-warning">
                  Секрет не сохранится, пока не задан ENCRYPTION_KEY.
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="vault-url">Ссылка / хост</Label>
              <Input
                id="vault-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://panel.site.com  или  185.12.3.4:22"
              />
            </div>

            {/* Custom fields */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Дополнительные поля</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() =>
                    setFields((prev) => [
                      ...prev,
                      { label: '', value: '', secret: false },
                    ])
                  }
                >
                  <Plus className="size-3.5" /> Поле
                </Button>
              </div>
              {fields.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  IP, порт, PIN, ключ восстановления, номер карты, seed-фраза —
                  что угодно. Отметьте «секрет», чтобы значение скрывалось.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {fields.map((f, i) => (
                    <div
                      key={i}
                      className="flex flex-col gap-2 rounded-md border border-border p-2 sm:flex-row sm:items-center"
                    >
                      <Input
                        value={f.label}
                        onChange={(e) =>
                          updateField(i, { label: e.target.value })
                        }
                        placeholder="Название"
                        className="sm:w-1/3"
                      />
                      <Input
                        value={f.value}
                        onChange={(e) =>
                          updateField(i, { value: e.target.value })
                        }
                        placeholder="Значение"
                        type={f.secret ? 'password' : 'text'}
                        className="flex-1 font-mono"
                      />
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Switch
                          checked={f.secret}
                          onCheckedChange={(v) =>
                            updateField(i, { secret: Boolean(v) })
                          }
                        />
                        секрет
                      </label>
                      <button
                        type="button"
                        onClick={() =>
                          setFields((prev) => prev.filter((_, idx) => idx !== i))
                        }
                        className="self-end rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive sm:self-auto"
                        aria-label="Удалить поле"
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="vault-tags">Теги</Label>
              <Input
                id="vault-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="через запятую: прод, важное, VPS"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="vault-note">Заметка</Label>
              <Textarea
                id="vault-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Детали, комментарии, контекст…"
              />
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Switch checked={favorite} onCheckedChange={(v) => setFavorite(Boolean(v))} />
              Закрепить вверху
            </label>
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
