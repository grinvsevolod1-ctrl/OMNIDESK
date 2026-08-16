'use client'

/**
 * Селект «Источник» в настройках канала (строка аккаунта): показывает, какому
 * источнику принадлежит канал, и позволяет привязать/отвязать его на месте —
 * без похода в диалог на «Обзоре». Данные тянутся одним SWR-ключом
 * 'sources-select' (дедуплицируется между всеми строками таблицы).
 */

import { useTransition } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import {
  assignChannelSourceAction,
  listSourcesForSelectAction,
} from '@/app/actions/sources'
import { useMutateSources } from '@/components/admin/sources/use-mutate-sources'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const NONE = 'none'

export function ChannelSourceSelect({ channelId }: { channelId: string }) {
  const [pending, startTransition] = useTransition()
  const mutateSources = useMutateSources()
  const { data } = useSWR(
    'sources-select',
    () => listSourcesForSelectAction(),
    { revalidateOnFocus: false },
  )

  const sources = data?.data?.sources ?? []
  const current =
    sources.find((s) => s.channelIds.includes(channelId))?.id ?? NONE
  const nameById = new Map(sources.map((s) => [s.id, s.name]))

  function assign(value: string) {
    const next = value === NONE ? null : value
    if ((next ?? NONE) === current) return
    startTransition(async () => {
      const res = await assignChannelSourceAction(channelId, next)
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
      // Смена канала меняет агрегаты Обзора — сбрасываем ВСЕ source-кэши,
      // а не только собственный селект.
      void mutateSources()
    })
  }

  return (
    <Select
      value={current}
      onValueChange={(v) => v && assign(v)}
      disabled={pending || !data}
    >
      <SelectTrigger
        className="h-9 min-w-0 flex-1"
        aria-label="Источник канала"
      >
        <SelectValue placeholder="Без источника">
          {(value: string | null) =>
            !value || value === NONE
              ? 'Без источника'
              : (nameById.get(value) ?? 'Источник')
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Без источника</SelectItem>
        {sources.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
