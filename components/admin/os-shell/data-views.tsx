'use client'

/**
 * Structured data panels for the OMNIDESK OS shell: the copilot SHOWS data
 * (metric cards, tables) instead of dumping numbers into prose. Each panel is
 * defensive about its payload shape — the payload crosses an SSE boundary, so
 * we validate at the edges and render nothing rather than crash the feed.
 */

import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import type { DataView } from '@/lib/admin-console/assistant'
import type { Dictionaries } from '@/lib/dictionaries'

export function DataViewPanel({ view }: { view: DataView }) {
  const body = renderBody(view)
  if (!body) return null
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card/60 backdrop-blur-sm duration-300 animate-in fade-in slide-in-from-bottom-2">
      <h3 className="border-b border-border px-3.5 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {view.title}
      </h3>
      <div className="p-3.5">{body}</div>
    </section>
  )
}

function renderBody(view: DataView) {
  switch (view.kind) {
    case 'stats':
      return <StatsPanel payload={view.payload} />
    case 'managers':
      return <ManagersPanel payload={view.payload} />
    case 'channels':
      return <ChannelsPanel payload={view.payload} />
    case 'proxies':
      return <ProxiesPanel payload={view.payload} />
    case 'contacts':
      return <ContactsPanel payload={view.payload} />
    case 'finance':
      return <FinancePanel payload={view.payload} />
    case 'dictionaries':
      return <DictionariesPanel payload={view.payload} />
    case 'schedules':
      return <SchedulesPanel payload={view.payload} />
    case 'dialogs':
      return <DialogsPanel payload={view.payload} />
    case 'messages':
      return <MessagesPanel payload={view.payload} />
    case 'manager_activity':
      return <ManagerActivityPanel payload={view.payload} />
    default:
      return null
  }
}

/* ----------------------------- dialogs ------------------------------ */

interface DialogRow {
  id: string
  contactName: string
  channelType: string
  managerName: string | null
  lastMessage: string
  lastMessageAt: string
  unread: number
}

function DialogsPanel({ payload }: { payload: unknown }) {
  const rows = asArray<DialogRow>(payload).filter((r) => r?.id)
  if (rows.length === 0) return <EmptyNote />
  return (
    <SimpleTable
      head={['Контакт', 'Канал', 'Менеджер', 'Последнее сообщение', 'Когда']}
      rows={rows.map((d) => [
        <span key="c" className="font-medium">
          {d.contactName}
          {d.unread > 0 ? (
            <span className="ml-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {d.unread}
            </span>
          ) : null}
        </span>,
        CHANNEL_LABEL[d.channelType] ?? d.channelType,
        d.managerName ?? '—',
        <span key="m" className="text-muted-foreground">
          {d.lastMessage || '—'}
        </span>,
        <span key="t" className="whitespace-nowrap text-xs text-muted-foreground">
          {formatWhen(d.lastMessageAt)}
        </span>,
      ])}
    />
  )
}

/* ----------------------------- messages ----------------------------- */

interface TranscriptMessage {
  direction: 'in' | 'out'
  author: string
  body: string
  createdAt: string
}

function MessagesPanel({ payload }: { payload: unknown }) {
  const obj = (payload ?? {}) as {
    contactName?: string
    managerName?: string | null
    messages?: unknown
  }
  const messages = asArray<TranscriptMessage>(obj.messages).filter(
    (m) => m?.body || m?.author,
  )
  if (messages.length === 0) return <EmptyNote />
  return (
    <div className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
      {messages.map((m, i) => (
        <div
          key={i}
          className={
            m.direction === 'in'
              ? 'flex flex-col items-start'
              : 'flex flex-col items-end'
          }
        >
          <div
            className={
              m.direction === 'in'
                ? 'max-w-[85%] rounded-lg rounded-tl-sm border border-border bg-background/50 px-3 py-1.5'
                : 'max-w-[85%] rounded-lg rounded-tr-sm bg-primary/15 px-3 py-1.5'
            }
          >
            <p className="text-[11px] font-medium text-muted-foreground">
              {m.author}
            </p>
            <p className="whitespace-pre-wrap text-sm">{m.body}</p>
          </div>
          <span className="mt-0.5 text-[10px] text-muted-foreground">
            {formatWhen(m.createdAt)}
          </span>
        </div>
      ))}
    </div>
  )
}

/* ------------------------- manager activity ------------------------- */

interface ManagerActivityViewRow {
  id: string
  name: string
  status: string
  dialogsTotal: number
  newDialogs: number
  contactsWrote: number
  inboundMessages: number
  unanswered: number
}

function ManagerActivityPanel({ payload }: { payload: unknown }) {
  const rows = asArray<ManagerActivityViewRow>(payload).filter((r) => r?.id)
  if (rows.length === 0) return <EmptyNote />
  return (
    <SimpleTable
      head={[
        'Менеджер',
        'Написало людей',
        'Входящих',
        'Новых диалогов',
        'Без ответа',
        'Всего диалогов',
      ]}
      rows={rows.map((m) => [
        <span key="n" className="font-medium">
          {m.name}
          {m.status !== 'active' ? (
            <span className="ml-1.5 text-xs text-muted-foreground">
              (заблокирован)
            </span>
          ) : null}
        </span>,
        <Num key="a" v={m.contactsWrote} highlight />,
        <Num key="b" v={m.inboundMessages} />,
        <Num key="c" v={m.newDialogs} />,
        <Num key="d" v={m.unanswered} warn={m.unanswered > 0} />,
        <Num key="e" v={m.dialogsTotal} />,
      ])}
    />
  )
}

function Num({
  v,
  highlight,
  warn,
}: {
  v: number
  highlight?: boolean
  warn?: boolean
}) {
  return (
    <span
      className={
        warn
          ? 'font-semibold tabular-nums text-destructive'
          : highlight
            ? 'font-semibold tabular-nums text-foreground'
            : 'tabular-nums text-muted-foreground'
      }
    >
      {v}
    </span>
  )
}

/** Compact relative/absolute timestamp for feed tables. */
function formatWhen(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  })
  if (sameDay) return time
  return `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${time}`
}

/* ---------------------------- schedules ----------------------------- */

interface ScheduleRow {
  id: string
  label: string
  human: string
  enabled: boolean
  lastRunAt: string | null
  lastResult: string | null
}

function SchedulesPanel({ payload }: { payload: unknown }) {
  const obj = (payload ?? {}) as { schedules?: unknown }
  const rows = asArray<ScheduleRow>(obj.schedules).filter((r) => r?.id)
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Запланированных команд пока нет. Скажите, например: «каждый понедельник
        в 9 присылай отчёт по лидам».
      </p>
    )
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li
          key={r.id}
          className="flex items-start gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5"
        >
          <span
            aria-hidden="true"
            className={
              r.enabled
                ? 'mt-1.5 size-2 shrink-0 rounded-full bg-success'
                : 'mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/50'
            }
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{r.label}</p>
            <p className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
              {r.human}
              {!r.enabled ? ' · выключено' : ''}
            </p>
            {r.lastResult ? (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                Последний запуск: {r.lastResult}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------ stats ------------------------------ */

function StatsPanel({ payload }: { payload: unknown }) {
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

/** Human channel names — raw enum keys must never reach the admin's eyes. */
const CHANNEL_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  livechat: 'Live Chat',
  max: 'MAX',
  vk: 'VK',
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

function ManagersPanel({ payload }: { payload: unknown }) {
  const rows = asArray<ManagerRow>(payload).filter((r) => r?.id && r?.name)
  if (rows.length === 0) return <EmptyNote />
  return (
    <SimpleTable
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

function ChannelsPanel({ payload }: { payload: unknown }) {
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

function ProxiesPanel({ payload }: { payload: unknown }) {
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

function ContactsPanel({ payload }: { payload: unknown }) {
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

function FinancePanel({ payload }: { payload: unknown }) {
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

function DictionariesPanel({ payload }: { payload: unknown }) {
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

/* ------------------------------ shared ------------------------------ */

function SimpleTable({
  head,
  rows,
}: {
  head: string[]
  rows: React.ReactNode[][]
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] text-sm">
        <thead>
          <tr className="border-b border-border">
            {head.map((h, i) => (
              <th
                key={i}
                scope="col"
                className="px-2 py-1.5 text-left font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, r) => (
            <tr key={r} className="border-b border-border/50 last:border-0">
              {cells.map((c, i) => (
                <td key={i} className="px-2 py-2 align-middle">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={
        ok
          ? 'inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-xs text-success'
          : 'inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground'
      }
    >
      <span
        className={
          ok
            ? 'size-1.5 rounded-full bg-success'
            : 'size-1.5 rounded-full bg-muted-foreground'
        }
      />
      {label}
    </span>
  )
}

function EmptyNote() {
  return <p className="text-sm text-muted-foreground">Нет данных.</p>
}

function RawJson({ payload }: { payload: unknown }) {
  let text = ''
  try {
    text = JSON.stringify(payload, null, 2)
  } catch {
    return <EmptyNote />
  }
  if (!text || text === '{}' || text === 'null') return <EmptyNote />
  return (
    <pre className="max-h-64 overflow-auto rounded-lg bg-background/60 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
      {text}
    </pre>
  )
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}
