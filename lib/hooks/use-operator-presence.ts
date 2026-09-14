'use client'

import { useEffect, useRef, useState } from 'react'
import { onStreamAgentPresence } from '@/lib/hooks/realtime-stream'

/**
 * Presence операторов «на смене» — полностью эфемерно, поверх уже
 * существующего realtime-транспорта (pg_notify → SSE). Никакой таблицы и
 * записи в БД: heartbeat открытой вкладки публикует сигнал, админская панель
 * держит его в памяти с TTL.
 */

const HEARTBEAT_MS = 25_000
/**
 * Сколько ждать следующий heartbeat, прежде чем считать оператора ушедшим.
 * Заведомо больше интервала (с запасом на троттлинг таймеров в фоновой
 * вкладке), чтобы открытая, но неактивная вкладка не «мигала» офлайном.
 */
const TTL_MS = 75_000

export type OperatorRole = 'manager' | 'curator' | 'head'

export interface OnlineOperator {
  id: string
  name: string
  role: OperatorRole
  /** Локальное время последнего heartbeat (Date.now()). */
  lastSeen: number
}

/**
 * Sender: смонтирован в оболочке дашборда. Пока вкладка открыта — раз в ~25с
 * шлёт heartbeat; при уходе (unmount / pagehide) — сигнал 'left'. Для не-
 * операторских ролей роут просто игнорирует пинг, так что хук безопасно
 * вызывать из общей оболочки.
 */
export function useOperatorPresenceHeartbeat(): void {
  useEffect(() => {
    const send = (state: 'active' | 'left') => {
      try {
        const payload = JSON.stringify({ state })
        if (state === 'left' && typeof navigator.sendBeacon === 'function') {
          // Надёжная доставка при закрытии вкладки — обычный fetch браузер
          // может отменить в unload.
          navigator.sendBeacon(
            '/api/presence/heartbeat',
            new Blob([payload], { type: 'application/json' }),
          )
          return
        }
        void fetch('/api/presence/heartbeat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
          keepalive: true,
        })
      } catch {
        /* presence best-effort */
      }
    }

    send('active')
    const id = window.setInterval(() => send('active'), HEARTBEAT_MS)
    // Возврат фокуса на вкладку — сразу подтверждаем присутствие, не дожидаясь
    // очередного тика (после фонового троттлинга запись могла истечь по TTL).
    const onVisible = () => {
      if (document.visibilityState === 'visible') send('active')
    }
    const onHide = () => send('left')
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pagehide', onHide)

    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pagehide', onHide)
      send('left')
    }
  }, [])
}

/**
 * Receiver: только на админском экране. Слушает кадры `agent-presence`, ведёт
 * карту онлайна и подчищает протухшие записи по TTL. Возвращает отсортированный
 * по имени список.
 */
export function useOnlineOperators(): OnlineOperator[] {
  const [operators, setOperators] = useState<OnlineOperator[]>([])
  const mapRef = useRef<Map<string, OnlineOperator>>(new Map())

  useEffect(() => {
    const flush = () =>
      setOperators(
        [...mapRef.current.values()].sort((a, b) =>
          a.name.localeCompare(b.name, 'ru'),
        ),
      )

    const unsub = onStreamAgentPresence((data) => {
      if (!data || typeof data !== 'object') return
      const e = data as {
        id?: string
        authorName?: string
        actorRole?: OperatorRole
        presence?: string
      }
      if (!e.id) return
      if (e.presence === 'left') {
        if (mapRef.current.delete(e.id)) flush()
        return
      }
      mapRef.current.set(e.id, {
        id: e.id,
        name: e.authorName?.trim() || 'Сотрудник',
        role: e.actorRole ?? 'manager',
        lastSeen: Date.now(),
      })
      flush()
    })

    const sweep = window.setInterval(() => {
      const cutoff = Date.now() - TTL_MS
      let changed = false
      for (const [k, v] of mapRef.current) {
        if (v.lastSeen < cutoff) {
          mapRef.current.delete(k)
          changed = true
        }
      }
      if (changed) flush()
    }, 15_000)

    return () => {
      unsub()
      window.clearInterval(sweep)
    }
  }, [])

  return operators
}
