'use client'

import { useEffect } from 'react'
import { pokeSharedPoll } from '@/lib/hooks/use-shared-poll'

/**
 * Push-обновление вьюх лидов: подписка на `/api/stream` (SSE) и мгновенный
 * «пинок» существующего shared-поллера при событии `lead` (триггер на
 * lead_cards, миграция 127). Сам поллинг остаётся редким фолбэком — SSE может
 * отвалиться на прокси, а потерянный NOTIFY (см. resync в lib/realtime)
 * невосполним, поэтому пояс и подтяжки: push для скорости, poll для гарантии.
 *
 * Дебаунс 300мс схлопывает шквал событий (массовая передача лидов, импорт)
 * в один refetch. EventSource переподключается сам; на 'ready' после
 * реконнекта тоже пинаем — за время разрыва события могли потеряться.
 */
export function useLeadEvents(pollKey: string): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const poke = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => pokeSharedPoll(pollKey), 300)
    }

    const es = new EventSource('/api/stream')
    es.addEventListener('lead', poke)
    // После (ре)коннекта сервер шлёт 'ready' — состояние могло разъехаться.
    let first = true
    es.addEventListener('ready', () => {
      if (first) {
        first = false // первый connect: данные только что отрендерены сервером
        return
      }
      poke()
    })

    return () => {
      if (timer) clearTimeout(timer)
      es.close()
    }
  }, [pollKey])
}
