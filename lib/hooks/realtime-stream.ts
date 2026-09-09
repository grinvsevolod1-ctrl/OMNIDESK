'use client'

/**
 * Один общий EventSource на вкладку для лёгких push-сигналов `lead` и `source`.
 *
 * Раньше каждый хук (список лидов, попап уведомлений, открытая карточка,
 * дашборды источников) открывал свой EventSource — на одной странице их
 * набегало несколько, и все дублировали heartbeat/бэкофилл. Здесь одна
 * подписка мультиплексируется между всеми потребителями: соединение
 * открывается на первом подписчике и закрывается, когда ушёл последний.
 *
 * Инбокс менеджера, чаты куратора, god-messenger и логи хостинга держат СВОИ
 * EventSource — у них другой жизненный цикл и семантика кадров, их не трогаем.
 */

type Handler = (data: unknown) => void

const DATA_EVENTS = ['lead', 'source'] as const
type DataEvent = (typeof DATA_EVENTS)[number]

const handlers: Record<DataEvent, Set<Handler>> = {
  lead: new Set(),
  source: new Set(),
}
const reconnectHandlers = new Set<() => void>()

let es: EventSource | null = null
let refs = 0
/**
 * Сколько раз сервер прислал кадр `ready`. Первый (=1) — начальный коннект,
 * данные уже свежие (SSR), реагировать не нужно. Каждый следующий — REконнект
 * после обрыва: за время разрыва NOTIFY могли потеряться, потребители обязаны
 * перезапросить данные. Правило «ready после первого = реконнект» одинаково
 * верно для всех подписчиков: тот, кто присоединился позже, начального кадра
 * уже не получит, а на любой последующий реконнект отреагирует корректно.
 */
let readyCount = 0

function open(): void {
  if (es || typeof window === 'undefined') return
  es = new EventSource('/api/stream')

  for (const name of DATA_EVENTS) {
    es.addEventListener(name, (e: MessageEvent) => {
      let data: unknown = null
      try {
        data = e.data ? JSON.parse(e.data) : null
      } catch {
        /* битый кадр игнорируем */
      }
      for (const fn of handlers[name]) {
        try {
          fn(data)
        } catch {
          /* изолируем: один плохой подписчик не рушит fan-out */
        }
      }
    })
  }

  es.addEventListener('ready', () => {
    readyCount += 1
    if (readyCount > 1) {
      for (const fn of reconnectHandlers) {
        try {
          fn()
        } catch {
          /* изолируем */
        }
      }
    }
  })
}

function release(): void {
  refs -= 1
  if (refs <= 0) {
    refs = 0
    if (es) {
      es.close()
      es = null
    }
    readyCount = 0
  }
}

/** Подписка на именованный кадр (`lead` | `source`). Возвращает отписку. */
export function onStreamEvent(name: DataEvent, fn: Handler): () => void {
  handlers[name].add(fn)
  refs += 1
  open()
  return () => {
    handlers[name].delete(fn)
    release()
  }
}

/** Подписка на РЕконнект (обрыв → восстановление), но не на начальный коннект. */
export function onStreamReconnect(fn: () => void): () => void {
  reconnectHandlers.add(fn)
  refs += 1
  open()
  return () => {
    reconnectHandlers.delete(fn)
    release()
  }
}
