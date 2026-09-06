'use client'

/**
 * Retry / stall-watchdog state for a media tile's `src`. Lives in a module-
 * level ledger keyed by URL so remounts (album regrouping, router.refresh)
 * continue where the previous instance stopped instead of hammering a URL
 * already known to be dead. Split out of message-media.tsx.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Задержки повторных попыток загрузки медиа. Первый запрос к /api/media у
 * СВЕЖЕГО исходящего сообщения гоняется с воркером: пузырь уже в ленте, а
 * provider_message_id ещё не записан → воркер отдаёт 410, и без ретрая плитка
 * навсегда залипала на «Медиа недоступно». Два отложенных повтора с
 * cache-buster'ом покрывают и эту гонку, и разовые сетевые сбои; после них —
 * честный fallback.
 */
const MEDIA_RETRY_DELAYS_MS = [1500, 4000]

/**
 * Журнал ретраев ЖИВЁТ ВНЕ инстанса компонента, по URL медиа.
 *
 * Плитки альбома и пузыри перемонтируются при каждой пересборке треда
 * (router.refresh после realtime-события, перегруппировка альбома), и
 * состояние внутри инстанса каждый раз стартовало цикл «запрос → 410 →
 * ретрай» с нуля: ровный поток заведомо обречённых запросов к медиа, про
 * которое уже известно, что его нет, а таймеры ретраев вообще не успевали
 * сработать — следующий ремаунт их обнулял. Новый инстанс продолжает с того
 * места, где остановился предыдущий, включая «уже упало, не спрашивай».
 * Записи протухают, чтобы файл, ставший доступным позже (архив восстановлен,
 * воркер поднялся), получил новый шанс без перезагрузки страницы.
 */
type MediaRetryEntry = { attempt: number; failed: boolean; at: number }
const mediaRetryLedger = new Map<string, MediaRetryEntry>()
const MEDIA_RETRY_LEDGER_MAX = 500
const MEDIA_RETRY_LEDGER_TTL_MS = 60_000

function readMediaRetry(url: string | undefined): MediaRetryEntry {
  const fresh: MediaRetryEntry = { attempt: 0, failed: false, at: Date.now() }
  if (!url) return fresh
  const hit = mediaRetryLedger.get(url)
  if (!hit) return fresh
  if (Date.now() - hit.at > MEDIA_RETRY_LEDGER_TTL_MS) {
    mediaRetryLedger.delete(url)
    return fresh
  }
  return hit
}

function writeMediaRetry(url: string, entry: MediaRetryEntry) {
  if (
    !mediaRetryLedger.has(url) &&
    mediaRetryLedger.size >= MEDIA_RETRY_LEDGER_MAX
  ) {
    const oldest = mediaRetryLedger.keys().next().value
    if (oldest !== undefined) mediaRetryLedger.delete(oldest)
  }
  mediaRetryLedger.set(url, entry)
}

/**
 * Сколько плитка ждёт ПЕРВОГО ответа по медиа, прежде чем считать загрузку
 * зависшей. Симптом «вечно грузится»: сервер не отвечает вовсе (воркер завис,
 * пул БД исчерпан), браузер не получает ни байта — ни onLoad, ни onError не
 * срабатывают, и шиммер висит навсегда. Watchdog превращает такое зависание
 * в обычную ошибку → ретрай с cache-buster'ом → честный fallback.
 * Чуть больше серверного дедлайна (60 с), чтобы не обгонять его 504.
 */
const MEDIA_STALL_MS = 70_000

export function useRetryingMediaSrc(url: string | undefined) {
  const [entry, setEntry] = useState<MediaRetryEntry>(() => readMediaRetry(url))
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stallRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settledRef = useRef(false)

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (stallRef.current) clearTimeout(stallRef.current)
    },
    [],
  )

  const onMediaError = useCallback(() => {
    if (!url) return
    settledRef.current = true
    if (stallRef.current) {
      clearTimeout(stallRef.current)
      stallRef.current = null
    }
    const current = readMediaRetry(url)
    if (current.failed) {
      setEntry(current)
      return
    }
    const next: MediaRetryEntry =
      current.attempt >= MEDIA_RETRY_DELAYS_MS.length
        ? { attempt: current.attempt, failed: true, at: Date.now() }
        : { attempt: current.attempt + 1, failed: false, at: Date.now() }
    // Advance the shared ledger NOW so an instance remounted before our timer
    // fires picks up the next attempt instead of restarting from zero.
    writeMediaRetry(url, next)
    if (next.failed) {
      setEntry(next)
      return
    }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setEntry(next)
    }, MEDIA_RETRY_DELAYS_MS[current.attempt])
  }, [url])

  /** Element reported first bytes / metadata / full load — cancel the watchdog. */
  const onMediaSettled = useCallback(() => {
    settledRef.current = true
    if (stallRef.current) {
      clearTimeout(stallRef.current)
      stallRef.current = null
    }
  }, [])

  // (Re)arm the stall watchdog for every distinct src attempt. Cleared as soon
  // as the element signals progress (load / loadedmetadata / error).
  useEffect(() => {
    if (!url || entry.failed) return
    settledRef.current = false
    if (stallRef.current) clearTimeout(stallRef.current)
    stallRef.current = setTimeout(() => {
      stallRef.current = null
      if (!settledRef.current) onMediaError()
    }, MEDIA_STALL_MS)
    return () => {
      if (stallRef.current) {
        clearTimeout(stallRef.current)
        stallRef.current = null
      }
    }
  }, [url, entry.attempt, entry.failed, onMediaError])

  // Cache-buster only on retries so the browser doesn't replay the failed
  // response; `?edit=` URLs already carry a query string — append with `&`.
  const src =
    url && entry.attempt > 0
      ? `${url}${url.includes('?') ? '&' : '?'}r=${entry.attempt}`
      : url

  return { src, failed: entry.failed, onMediaError, onMediaSettled }
}
