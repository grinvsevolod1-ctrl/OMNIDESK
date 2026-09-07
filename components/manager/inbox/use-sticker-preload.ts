'use client'

/**
 * Prewarms an account's sticker palette so the sticker panel opens instantly
 * and its thumbnails are already painted — instead of the panel showing a
 * spinner and then loading dozens of webp thumbs one-by-one on first open
 * (which is what felt laggy).
 *
 * Two layers, both fired on IDLE so they never compete with opening the thread:
 *  1. Palette — `preload()` populates SWR's cache under the SAME key the panel's
 *     `useSWR` uses, so the list is there the moment the panel mounts.
 *  2. Thumbnails — each sticker's static preview is fetched into the browser's
 *     HTTP cache via an off-DOM `Image()`, throttled to a few in flight so we
 *     don't flood the worker. A module-level Set makes it idempotent across
 *     re-opens and channel switches within the session.
 */

import { useEffect } from 'react'
import { preload } from 'swr'
import type { StickerItem } from '@/lib/types'
import { stickersFetcher, stickersKey, stickerThumbUrl } from './pickers'

// Thumbnails already warmed this session — survives remounts and channel flips.
const warmedThumbs = new Set<string>()
// Channels whose palette warm-up already ran, so switching back is a no-op.
const warmedPalettes = new Set<string>()

const THUMB_CONCURRENCY = 4

function warmThumbs(channelId: string, items: StickerItem[]): void {
  const urls = items
    .map((s) => stickerThumbUrl(channelId, s))
    .filter((u) => !warmedThumbs.has(u))
  if (urls.length === 0) return

  let cursor = 0
  const pump = (): void => {
    const url = urls[cursor++]
    if (!url) return
    warmedThumbs.add(url)
    const img = new Image()
    // Resolve to the next URL whether it loads or errors — a broken thumb must
    // not stall the queue.
    img.onload = pump
    img.onerror = pump
    img.src = url
  }
  for (let i = 0; i < Math.min(THUMB_CONCURRENCY, urls.length); i++) pump()
}

function onIdle(cb: () => void): () => void {
  if (
    typeof window !== 'undefined' &&
    typeof window.requestIdleCallback === 'function'
  ) {
    const id = window.requestIdleCallback(cb, { timeout: 2000 })
    return () => window.cancelIdleCallback(id)
  }
  const id = setTimeout(cb, 600)
  return () => clearTimeout(id)
}

/**
 * Call from the composer with the active channel. Runs once per channel per
 * session; does nothing when stickers are disabled or the channel is unset.
 */
export function useStickerPreload(channelId: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !channelId || warmedPalettes.has(channelId)) return
    let cancelled = false

    const cancelIdle = onIdle(() => {
      warmedPalettes.add(channelId)
      void preload(stickersKey(channelId), stickersFetcher).then((items) => {
        if (cancelled || !Array.isArray(items)) return
        warmThumbs(channelId, items)
      })
    })

    return () => {
      cancelled = true
      cancelIdle()
    }
  }, [channelId, enabled])
}
