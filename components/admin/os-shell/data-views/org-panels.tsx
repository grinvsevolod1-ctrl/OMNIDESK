'use client'

/**
 * Organisation-level panels: the metric-card stats grid, managers (with the
 * one-time password chip), channels, proxies, contact counts, finance entries
 * and the dictionary reference.
 */

import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import type { Dictionaries } from '@/lib/dictionaries'
import {
  asArray,
  CHANNEL_LABEL,
  EmptyNote,
  RawJson,
  SimpleTable,
  StatusBadge,
} from './shared'

/* ------------------------------ stats ------------------------------ */

export function StatsPanel({ payload }: { payload: unknown }) {
  // Generic metric grid: flatten one level of numeric fields into cards.
  const entries = flattenMetrics(payload)
  if (entries.length === 0) return <RawJson payload={payload} />
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {entries.slice(0, 12).map(([k, v]) => (
        <div
          key={k}
          className="rounded-lg border border-border bg-background/40 px-3 py-2.5"
        >
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {metricLabel(k)}
          </dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums text-foreground">
            {v}
          </dd>
        </div>
      ))}
    </dl>
  )
}

const METRIC_LABEL: Record<string, string> = {
  totalManagers: 'Менеджеров',
  activeManagers: 'Активных',
  blockedManagers: 'Заблокировано',
  totalChannels: 'Каналов',
  connectedChannels: 'Подключено',
  totalLeads: 'Лидов всего',
  newThisWeek: 'Новых за неделю',
  unanswered: 'Без ответа',
  totalConversations: 'Диалогов',
  totalContacts: 'Контактов',
  totalProxies: 'Прокси',
  workingProxies: 'Рабочих прокси',
}

/**
 * Every metric key becomes a human label: known keys map directly; nested
 * `channelsByType.telegram`-style keys render as the channel's display name;
 * anything else falls back to a de-camel-cased last segment — never the raw
 * dotted key (the «CHANNELSBYTYPE.TELEGRAM» bug).
 */
function metricLabel(key: string): string {
  if (METRIC_LABEL[key]) return METRIC_LABEL[key]
  const parts = key.split('.')
  const last = parts[parts.length - 1]
  if (parts.length > 1 && parts[0] === 'channelsByType')
    return CHANNEL_LABEL[last] ?? last.toUpperCase()
  if (METRIC_LABEL[last]) return METRIC_LABEL[last]
  if (CHANNEL_LABEL[last]) return CHANNEL_LABEL[last]
  // deCamel: "newThisWeek" -> "new this week"
  return last.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}

function flattenMetrics(payload: unknown): [string, number][] {
  if (!payload || typeof payload !== 'object') return []
  const out: [string, number][] = []
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number') out.push([prefix ? `${prefix}.${k}` : k, v])
      else if (v && typeof v === 'object' && !Array.isArray(v) && !prefix)
        walk(v as Record<string, unknown>, k)
    }
  }
  walk(payload as Record<string, unknown>, '')
  return out
}

/* ----------------------------- managers ----------------------------- */

interface ManagerRow {
  id: string
  name: string
  email: string
  status: string
  tempPassword?: string
}

export function ManagersPanel({
  payload,
  onCommand,
}: {
  payload: unknown
  onCommand?: (prompt: string) => void
}) {
  const rows = asArray<ManagerRow>(payload).filter((r) => r?.id && r?.name)
  if (rows.length === 0) return <EmptyNote />
  return (
    <SimpleTable
      onRowClick={
        onCommand
          ? (i) => onCommand(`Покажи диалоги менеджера ${rows[i].name}`)
          : undefined
      }
      head={['Имя', 'Email', 'Статус', '']}
      rows={rows.map((m) => [
        m.name,
        m.email,
        <StatusBadge
          key="s"
          ok={m.status === 'active'}
          label={m.status === 'active' ? 'Активен' : 'Заблокирован'}
        />,
        m.tempPassword ? <TempPassword key="p" value={m.tempPassword} /> : '',
      ])}
    />
  )
}

/** One-time credential chip with copy — shown only right after creation. */
function TempPassword({ value }: { value: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success('Пароль скопирован')
    } catch {
      toast.error('Не удалось скопировать')
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 font-mono text-xs text-primary hover:bg-primary/20"
    >
      {value}
      <Copy className="size-3" />
    </button>
  )
}

/* ----------------------------- channels ----------------------------- */

interface ChannelRow {
  id: string
  typeLabel?: string
  type?: string
  name: string
  statusLabel?: string
  status?: string
  managerName?: string | null
}

export function ChannelsPanel({ payload }: { payload: unknown }) {
  const rows = asArray<ChannelRow>(payload).filter((r) => r?.id)
  if (rows.length === 0) return <EmptyNote />
  return (
    <SimpleTable
      head={['Канал', 'Тип', 'Статус', 'Менеджер']}
      rows={rows.map((c) => [
        c.name,
        c.typeLabel ?? c.type ?? '',
        <StatusBadge
          key="s"
          ok={c.status === 'connected'}
          label={c.statusLabel ?? c.status ?? ''}
        />,
        c.managerName ?? '—',
      ])}
    />
  )
}

/* ------------------------------ proxies ----------------------------- */

interface ProxyRow {
  id: string
  label: string
  host: string
  statusLabel?: string
  status?: string
}

export function ProxiesPanel({ payload }: { payload: unknown }) {
  const obj = (payload ?? {}) as { rows?: unknown }
  const rows = asArray<ProxyRow>(obj.rows ?? payload).filter((r) => r?.id)
  if (rows.length === 0) return <EmptyNote />
  return (
    <SimpleTable
      head={['Прокси', 'Хост', 'Статус']}
      rows={rows.map((p) => [
        p.label,
        <span key="h" className="font-mono text-xs">
          {p.host}
        </span>,
        <StatusBadge
          key="s"
          ok={p.status === 'ok'}
          label={p.statusLabel ?? p.status ?? ''}
        />,
      ])}
    />
  )
}

/* ----------------------------- contacts ----------------------------- */

interface ContactGroupRow {
  channelType: string
  count: number
}

export function ContactsPanel({ payload }: { payload: unknown }) {
  const obj = (payload ?? {}) as { groups?: unknown }
  const groups = asArray<ContactGroupRow>(obj.groups).filter(
    (g) => g?.channelType,
  )
  if (groups.length === 0) return <EmptyNote />
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {groups.map((g) => (
        <div
          key={g.channelType}
          className="rounded-lg border border-border bg-background/40 px-3 py-2.5"
        >
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {CHANNEL_LABEL[g.channelType] ?? g.channelType}
          </dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums">{g.count}</dd>
        </div>
      ))}
    </dl>
  )
}

/* ------------------------------ finance ----------------------------- */

interface FinanceEntryRow {
  id: string
  title: string
  vendor: string
  amount: number
  status: string
  entryDate: string
}

export function FinancePanel({ payload }: { payload: unknown }) {
  const obj = (payload ?? {}) as { entries?: unknown; totalUsd?: number }
  const entries = asArray<FinanceEntryRow>(obj.entries).filter((e) => e?.id)
  return (
    <div className="flex flex-col gap-3">
      {typeof obj.totalUsd === 'number' ? (
        <p className="font-mono text-sm text-muted-foreground">
          Итого:{' '}
          <span className="font-semibold text-foreground">
            ${obj.totalUsd.toFixed(2)}
          </span>
        </p>
      ) : null}
      {entries.length > 0 ? (
        <SimpleTable
          head={['Запись', 'Поставщик', 'Сумма', 'Дата']}
          rows={entries
            .slice(0, 20)
            .map((e) => [
              e.title,
              e.vendor || '—',
              `$${e.amount.toFixed(2)}`,
              e.entryDate,
            ])}
        />
      ) : (
        <EmptyNote />
      )}
    </div>
  )
}

/* --------------------------- dictionaries --------------------------- */

export function DictionariesPanel({ payload }: { payload: unknown }) {
  const dict = payload as Partial<Dictionaries> | null
  if (!dict || typeof dict !== 'object') return <EmptyNote />
  const metaSections: [string, Record<string, { label: string }> | undefined][] =
    [
      ['Статусы лидов', dict.leadStatuses],
      ['Причины неликвида', dict.notLiquidReasons],
    ]
  const labelSections: [string, Record<string, string> | undefined][] = [
    ['Каналы', dict.channelTypes],
    ['Статусы аккаунтов', dict.accountStatuses],
    ['Статусы прокси', dict.proxyStatuses],
  ]
  return (
    <div className="flex flex-col gap-4">
      {metaSections.map(([title, section]) =>
        section ? (
          <DictGroup
            key={title}
            title={title}
            items={Object.entries(section).map(([k, v]) => [k, v.label])}
          />
        ) : null,
      )}
      {labelSections.map(([title, section]) =>
        section ? (
          <DictGroup
            key={title}
            title={title}
            items={Object.entries(section)}
          />
        ) : null,
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        Чтобы изменить название — просто скомандуйте, например: «переименуй
        статус Ликвид в Горячий».
      </p>
    </div>
  )
}

function DictGroup({
  title,
  items,
}: {
  title: string
  items: [string, string][]
}) {
  return (
    <div>
      <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {title}
      </h4>
      <ul className="flex flex-wrap gap-1.5">
        {items.map(([key, label]) => (
          <li
            key={key}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/40 px-2.5 py-1 text-xs"
          >
            <span className="font-mono text-[10px] text-muted-foreground">
              {key}
            </span>
            <span className="font-medium">{label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
