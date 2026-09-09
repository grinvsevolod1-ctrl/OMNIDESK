'use client'

import { useEffect, useRef } from 'react'
import { pokeSharedPoll } from '@/lib/hooks/use-shared-poll'
import { onStreamEvent, onStreamReconnect } from '@/lib/hooks/realtime-stream'

/**
 * Push-обновление вьюх лидов: подписка на общий `/api/stream` (SSE) и мгновенный
 * «пинок» существующих shared-поллеров при событии `lead` (триггер на
 * lead_cards, миграция 127). Сам поллинг остаётся редким фолбэком — SSE может
 * отвалиться на прокси, а потерянный NOTIFY (см. resync в lib/realtime)
 * невосполним, поэтому пояс и подтяжки: push для скорости, poll для гарантии.
 *
 * `pollKey` — один ключ или массив: одна подписка пинает несколько поллеров
 * сразу (напр. список лидов + попап уведомлений куратора). Все хуки на странице
 * мультиплексируются через ЕДИНЫЙ EventSource (см. realtime-stream), поэтому
 * лишних соединений не появляется.
 *
 * Дебаунс 300мс схлопывает шквал событий (массовая передача, импорт) в один
 * refetch. На реконнекте тоже пинаем — за время разрыва события могли потеряться.
 */
export function useLeadEvents(pollKey: string | string[]): void {
  // Стабилизируем массив ключей строкой, чтобы новый литерал массива на каждый
  // рендер не пересоздавал подписку.
  const keysCsv = Array.isArray(pollKey) ? pollKey.join(',') : pollKey
  useEffect(() => {
    const keys = keysCsv.split(',')
    let timer: ReturnType<typeof setTimeout> | null = null
    const poke = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        for (const k of keys) pokeSharedPoll(k)
      }, 300)
    }

    const offLead = onStreamEvent('lead', poke)
    const offReconnect = onStreamReconnect(poke)

    return () => {
      if (timer) clearTimeout(timer)
      offLead()
      offReconnect()
    }
  }, [keysCsv])
}

/**
 * Push-обновление произвольного потребителя по событиям `lead`/`source` через
 * тот же общий поток. В отличие от useLeadEvents (который пинает shared-поллеры
 * по ключу), здесь вызывается переданный колбэк — для SWR `mutate`,
 * `router.refresh()` или локального рефетча.
 *
 * Фильтрация по id опциональна и раздельна:
 *   • `leadId`  — реагировать только на события ЭТОЙ карточки лида
 *     (событие несёт id с миграции 170). Открытая карточка обновляется, когда
 *     её меняет другой сотрудник, не дёргаясь на чужие лиды.
 *   • `sourceId` — реагировать только на события ЭТОГО источника
 *     (расход/депозит/сам источник).
 * id без совпадающего фильтра проходит как «касается всех» (обратная
 * совместимость со старыми кадрами без id).
 *
 * На реконнекте колбэк вызывается всегда (данные могли разъехаться за разрыв).
 * Дебаунс схлопывает пачки событий в один рефетч.
 */
export function useRealtimeRefresh(opts: {
  onRefresh: () => void
  lead?: boolean
  source?: boolean
  /** Реагировать на событие 'channel' (напр. виджет livechat подключился). */
  channel?: boolean
  leadId?: string | null
  sourceId?: string | null
  debounceMs?: number
}): void {
  const {
    lead = false,
    source = false,
    channel = false,
    leadId = null,
    sourceId = null,
    debounceMs = 300,
  } = opts
  // Держим свежий колбэк в ref, чтобы не пересоздавать подписку на каждый
  // рендер (onRefresh обычно — новый литерал стрелки). Обновляем в эффекте, а
  // не во время рендера.
  const onRefreshRef = useRef(opts.onRefresh)
  useEffect(() => {
    onRefreshRef.current = opts.onRefresh
  })

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const fire = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => onRefreshRef.current(), debounceMs)
    }

    const offs: Array<() => void> = []

    if (lead) {
      offs.push(
        onStreamEvent('lead', (data) => {
          const id = (data as { id?: string } | null)?.id
          if (leadId && id && id !== leadId) return
          fire()
        }),
      )
    }
    if (source) {
      offs.push(
        onStreamEvent('source', (data) => {
          const id = (data as { id?: string } | null)?.id
          if (sourceId && id && id !== sourceId) return
          fire()
        }),
      )
    }
    if (channel) {
      offs.push(onStreamEvent('channel', fire))
    }
    if (lead || source || channel) offs.push(onStreamReconnect(fire))

    return () => {
      if (timer) clearTimeout(timer)
      for (const off of offs) off()
    }
  }, [lead, source, channel, leadId, sourceId, debounceMs])
}
