'use client'

import { useEffect } from 'react'
import {
  getChannelStatusesAction,
  type ChannelStatusSnapshot,
} from '@/app/actions/channels'

/**
 * Shared channel-status poller.
 *
 * Every ChannelCard used to run its own 15s setInterval hitting the server
 * with one request per card — a page with 12 accounts fired 12 parallel
 * server actions every tick. This module keeps ONE interval and ONE batched
 * request for all subscribed cards, fanning results out to listeners.
 *
 * The interval starts with the first subscriber and stops with the last, and
 * skips ticks while the tab is hidden (the next visible tick catches up).
 */

type Listener = (snap: ChannelStatusSnapshot) => void

const POLL_MS = 15_000

const listeners = new Map<string, Set<Listener>>()
let timer: ReturnType<typeof setInterval> | null = null
let inFlight = false

async function tick(): Promise<void> {
  if (typeof document !== 'undefined' && document.hidden) return
  if (inFlight) return // never stack requests if the server is slow
  const ids = Array.from(listeners.keys())
  if (ids.length === 0) return
  inFlight = true
  try {
    const map = await getChannelStatusesAction(ids)
    for (const [id, subs] of listeners) {
      const snap = map[id]
      if (snap) for (const fn of subs) fn(snap)
    }
  } catch {
    // Transient network failure — the next tick retries.
  } finally {
    inFlight = false
  }
}

function subscribe(channelId: string, fn: Listener): () => void {
  let set = listeners.get(channelId)
  if (!set) {
    set = new Set()
    listeners.set(channelId, set)
  }
  set.add(fn)
  if (!timer) timer = setInterval(() => void tick(), POLL_MS)

  return () => {
    const subs = listeners.get(channelId)
    if (subs) {
      subs.delete(fn)
      if (subs.size === 0) listeners.delete(channelId)
    }
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/**
 * Subscribe to live status updates for one channel. `onSnapshot` fires every
 * poll tick with the fresh snapshot; it should be stable (useCallback) or the
 * subscription will churn.
 */
export function useChannelStatus(
  channelId: string,
  enabled: boolean,
  onSnapshot: Listener,
): void {
  useEffect(() => {
    if (!enabled) return
    return subscribe(channelId, onSnapshot)
  }, [channelId, enabled, onSnapshot])
}
