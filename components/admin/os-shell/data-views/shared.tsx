'use client'

/**
 * Shared primitives for the copilot data panels: the accessible drill-down
 * table, status badges, empty/JSON fallbacks and small formatting helpers.
 * Every panel file builds on these so tables and badges stay identical
 * across the whole feed.
 */

/** Human channel names — raw enum keys must never reach the admin's eyes. */
export const CHANNEL_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  livechat: 'Live Chat',
  max: 'MAX',
  vk: 'VK',
}

/** «42%» or «—» for nullable metric percentages. */
export function pct(v: number | null): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}%` : '—'
}

/** Compact relative/absolute timestamp for feed tables. */
export function formatWhen(iso: string): string {
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

export function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

export function Num({
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

export function SimpleTable({
  head,
  rows,
  onRowClick,
}: {
  head: string[]
  rows: React.ReactNode[][]
  /** Makes rows drill-downable (click / Enter / Space issues a command). */
  onRowClick?: (rowIndex: number) => void
}) {
  const activate = (
    e: React.MouseEvent | React.KeyboardEvent,
    rowIndex: number,
  ) => {
    if (!onRowClick) return
    // Buttons/links inside cells (copy password, etc.) keep their own click —
    // the row drill-down must not hijack them.
    if ((e.target as HTMLElement).closest('button, a')) return
    onRowClick(rowIndex)
  }
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
            <tr
              key={r}
              className={
                onRowClick
                  ? 'cursor-pointer border-b border-border/50 transition-colors last:border-0 hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none'
                  : 'border-b border-border/50 last:border-0'
              }
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? 'button' : undefined}
              onClick={(e) => activate(e, r)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  activate(e, r)
                }
              }}
            >
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

export function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
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

export function EmptyNote() {
  return <p className="text-sm text-muted-foreground">Нет данных.</p>
}

export function RawJson({ payload }: { payload: unknown }) {
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
