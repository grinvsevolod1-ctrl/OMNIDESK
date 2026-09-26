'use client'

import { useMemo, useState } from 'react'
import { History, Loader2 } from 'lucide-react'
import { nf } from '@/components/admin/secret-sites/site-editor-helpers'
import { stateForPeriod, type AllTimeEntry } from '@/lib/god-sites-projection'
import type { SiteState } from '@/lib/god-sites-types'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

const FIELDS = [
  { key: 'cost', label: 'Расход' },
  { key: 'shows', label: 'Показы' },
  { key: 'clicks', label: 'Клики' },
  { key: 'goals', label: 'Конверсии' },
  { key: 'revenue', label: 'Доход' },
] as const

type FieldKey = (typeof FIELDS)[number]['key']
type Draft = Record<string, Partial<Record<FieldKey, string>>>

/**
 * «Всё время» baseline: the operator types the true all-time totals per
 * campaign, the server pins them, and every spend after that moment is added
 * on top. Empty inputs keep what the vitrine shows now.
 */
export function SiteAllTimeCard({
  state,
  pending,
  onSubmit,
}: {
  state: SiteState
  pending: boolean
  onSubmit: (entries: Record<string, AllTimeEntry>) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<Draft>({})
  const current = useMemo(
    () =>
      new Map(
        stateForPeriod(state, 'all', new Date()).campaigns.map((c) => [c.id, c]),
      ),
    [state],
  )
  const setAt = state.autoSpend?.allTime?.setAt

  function buildEntries(): Record<string, AllTimeEntry> | null {
    const out: Record<string, AllTimeEntry> = {}
    for (const [id, fields] of Object.entries(draft)) {
      const entry: AllTimeEntry = {}
      for (const [k, raw] of Object.entries(fields)) {
        const s = (raw ?? '').trim()
        if (!s) continue
        const n = Number(s.replace(',', '.'))
        if (!Number.isFinite(n) || n < 0) return null
        entry[k as FieldKey] = n
      }
      if (Object.keys(entry).length > 0) out[id] = entry
    }
    return out
  }

  async function submit() {
    const entries = buildEntries()
    if (!entries) return
    if (Object.keys(entries).length === 0) return
    if (
      !window.confirm(
        'Зафиксировать «Всё время»? Введённые числа станут единственно верными, новые данные будут прибавляться к ним.',
      )
    ) {
      return
    }
    if (await onSubmit(entries)) setDraft({})
  }

  const entries = buildEntries()
  const invalid = entries === null
  const empty = !invalid && Object.keys(entries).length === 0

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Всё время — ручная фиксация</h2>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
          Впишите итог за всё время — он станет единственно верным, а всё, что
          скрутится после, будет прибавляться к нему. Пустое поле оставляет
          текущее значение. «Сегодня», «Вчера», «Неделя», «Месяц» и баланс не
          меняются.
          {setAt && (
            <>
              {' '}
              Последняя фиксация:{' '}
              <span className="font-mono text-foreground">
                {new Date(setAt).toLocaleString('ru-RU', {
                  timeZone: 'Europe/Moscow',
                })}{' '}
                МСК
              </span>
              .
            </>
          )}
        </p>
      </div>

      {state.campaigns.length === 0 ? (
        <p className="text-sm text-muted-foreground">Нет кампаний</p>
      ) : (
        <div className="flex flex-col gap-3">
          {state.campaigns.map((c) => {
            const cur = current.get(c.id)
            return (
              <div
                key={c.id}
                className="flex flex-col gap-2 rounded-md border border-border p-3"
              >
                <p className="truncate text-sm font-medium">{c.name || c.id}</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {FIELDS.map((f) => {
                    const inputId = `alltime-${c.id}-${f.key}`
                    return (
                      <div key={f.key} className="flex flex-col gap-1">
                        <label
                          htmlFor={inputId}
                          className="text-xs text-muted-foreground"
                        >
                          {f.label}
                        </label>
                        <Input
                          id={inputId}
                          inputMode="decimal"
                          placeholder={nf.format(cur?.[f.key] ?? 0)}
                          value={draft[c.id]?.[f.key] ?? ''}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              [c.id]: { ...d[c.id], [f.key]: e.target.value },
                            }))
                          }
                          className="font-mono"
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {invalid
            ? 'Только неотрицательные числа'
            : 'Подсказка в поле — то, что витрина показывает сейчас'}
        </p>
        <Button
          type="button"
          size="sm"
          onClick={submit}
          disabled={pending || invalid || empty}
        >
          {pending && <Loader2 className="size-4 animate-spin" />}
          Зафиксировать
        </Button>
      </div>
    </Card>
  )
}
