'use client'

import { useMemo, useState, useTransition } from 'react'
import { ArrowLeft, Loader2, Search, Shuffle } from 'lucide-react'
import { toast } from 'sonner'
import { secretCreateConversationAction } from '@/app/actions/admin-secret'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Channel } from '@/lib/types'
import { TYPE_LABEL } from './utils'
import {
  getDialogScenarios,
  SCENARIO_COUNT,
  type DialogScenario,
} from './dialog-scenarios'

/** Rows rendered per "page" — keeps the 1000-item list snappy on mobile. */
const PAGE = 40

/** `datetime-local` value (local tz) for "now", used as the default. */
function nowLocalValue(): string {
  const d = new Date()
  d.setSeconds(0, 0)
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 16)
}

/**
 * "Сценарии" tab of the new-chat dialog: browse/search the 1000 generated
 * candidate openers, pick one, then choose the channel and the creation time —
 * the thread is created as a real incoming client message (optionally
 * backdated).
 */
export function ScenarioPicker({
  channels,
  onCreated,
}: {
  channels: Channel[]
  onCreated: (id?: string) => void
}) {
  const ownedChannels = useMemo(
    () => channels.filter((c) => c.managerId),
    [channels],
  )
  const scenarios = useMemo(() => getDialogScenarios(), [])

  const [search, setSearch] = useState('')
  const [visible, setVisible] = useState(PAGE)
  const [selected, setSelected] = useState<DialogScenario | null>(null)
  const [channelId, setChannelId] = useState('')
  const [createdAt, setCreatedAt] = useState(nowLocalValue)
  const [pending, startTransition] = useTransition()

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return scenarios
    return scenarios.filter(
      (s) =>
        s.contactName.toLowerCase().includes(q) ||
        s.vacancyTitle.toLowerCase().includes(q) ||
        s.city.toLowerCase().includes(q) ||
        s.intro.toLowerCase().includes(q) ||
        String(s.id + 1) === q,
    )
  }, [scenarios, search])

  const randomPick = () => {
    setSelected(scenarios[Math.floor(Math.random() * scenarios.length)])
  }

  const submit = () => {
    if (!selected) return
    if (!channelId) {
      toast.error('Выберите канал')
      return
    }
    const when = new Date(createdAt)
    if (Number.isNaN(when.getTime())) {
      toast.error('Некорректное время создания')
      return
    }
    startTransition(async () => {
      const res = await secretCreateConversationAction({
        channelId,
        contactName: selected.contactName,
        contactHandle: selected.contactHandle,
        message: selected.intro,
        createdAt: when.toISOString(),
      })
      if (res.ok) {
        toast.success(res.message)
        onCreated(res.id)
      } else {
        toast.error(res.message)
      }
    })
  }

  /* ------------------------- Step 2: confirm form ------------------------- */
  if (selected) {
    return (
      <div className="grid gap-3">
        <button
          type="button"
          onClick={() => setSelected(null)}
          className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          {'К списку сценариев'}
        </button>

        <div className="rounded-lg border bg-muted/40 p-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {'Сценарий №' + (selected.id + 1) + ' · ' + selected.contactName}
          </p>
          <p className="text-sm leading-relaxed">{selected.intro}</p>
        </div>

        <div className="rounded-lg border border-dashed p-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {'Контекст диалога'}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {selected.context}
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label className="text-xs text-muted-foreground">{'Канал'}</Label>
          <Select value={channelId} onValueChange={(v) => setChannelId(v ?? '')}>
            <SelectTrigger>
              <SelectValue placeholder="Выберите канал" />
            </SelectTrigger>
            <SelectContent>
              {ownedChannels.length === 0 ? (
                <SelectItem value="none" disabled>
                  {'Нет каналов с менеджером'}
                </SelectItem>
              ) : (
                ownedChannels.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {(TYPE_LABEL[c.type] ?? c.type) + ' · ' + c.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label className="text-xs text-muted-foreground">
            {'Время создания диалога'}
          </Label>
          <Input
            type="datetime-local"
            value={createdAt}
            max={nowLocalValue()}
            onChange={(e) => setCreatedAt(e.target.value)}
          />
        </div>

        <Button onClick={submit} disabled={pending} className="gap-1.5">
          {pending && <Loader2 className="size-4 animate-spin" />}
          {'Создать диалог'}
        </Button>
      </div>
    )
  }

  /* --------------------------- Step 1: browse ----------------------------- */
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setVisible(PAGE)
            }}
            placeholder={'Поиск по ' + SCENARIO_COUNT + ' сценариям…'}
            className="pl-8"
          />
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={randomPick}
          title="Случайный сценарий"
          aria-label="Случайный сценарий"
        >
          <Shuffle className="size-4" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {'Найдено: ' + filtered.length + ' из ' + SCENARIO_COUNT}
      </p>

      <div className="grid max-h-[45dvh] gap-1.5 overflow-y-auto pr-1">
        {filtered.slice(0, visible).map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSelected(s)}
            className="rounded-lg border p-2.5 text-left transition-colors hover:border-primary/50 hover:bg-muted/50"
          >
            <div className="mb-0.5 flex items-center justify-between gap-2">
              <span className="text-xs font-medium">
                {'№' + (s.id + 1) + ' · ' + s.contactName + ', ' + s.age}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {s.match + '%'}
              </span>
            </div>
            <p className="mb-1 text-[11px] text-muted-foreground">
              {s.vacancyTitle + ' · ' + s.city + ' · ' + s.salary}
            </p>
            <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">
              {s.intro}
            </p>
          </button>
        ))}
        {filtered.length > visible && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setVisible((v) => v + PAGE)}
          >
            {'Показать ещё (' + (filtered.length - visible) + ')'}
          </Button>
        )}
        {filtered.length === 0 && (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {'Ничего не найдено'}
          </p>
        )}
      </div>
    </div>
  )
}
