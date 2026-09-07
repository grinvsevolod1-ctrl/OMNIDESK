'use client'

/**
 * Renderer for Telegram's animated TGS stickers (gzipped Lottie JSON).
 * An <img> cannot display these — which is why animated stickers used to
 * degrade to the "[Стикер]" text fallback. We fetch the raw bytes, gunzip
 * them with the browser-native DecompressionStream (no extra dependency),
 * and play the animation with lottie-web's CANVAS renderer.
 *
 * Performance (why this used to lag):
 *  - The SVG renderer builds hundreds of animated DOM nodes PER sticker and
 *    animates them via reflow — with several stickers in a thread the main
 *    thread melts. The canvas renderer paints one <canvas> instead, which is
 *    an order of magnitude cheaper. We use the `lottie_light_canvas` build so
 *    only the canvas renderer ships (no expressions, smallest bundle).
 *  - Decoding a .tgs = fetch + gunzip + JSON.parse. Without a cache every
 *    scroll-back re-does all three; `animCache` keeps decoded data by URL and
 *    `inflight` dedupes concurrent decodes of the same sticker.
 *  - Lottie keeps a requestAnimationFrame loop running even when the sticker
 *    is scrolled out of view. An IntersectionObserver pauses off-screen
 *    stickers so only the ones you can actually see burn CPU.
 */

import { useEffect, useRef, useState } from 'react'

interface TgsStickerProps {
  /** Same-origin URL streaming the raw .tgs bytes (e.g. /api/media/{id}). */
  url: string
  /** Emoji/alt fallback shown while loading or if decoding fails. */
  alt: string
  /** Notify the parent that decoding failed so it can render its fallback. */
  onError: () => void
  /** Bytes arrived — lets the parent cancel its stalled-load watchdog. */
  onLoad?: () => void
}

type LottieAnim = {
  destroy: () => void
  play: () => void
  pause: () => void
}
type LottiePlayer = {
  loadAnimation: (params: Record<string, unknown>) => LottieAnim
}

/**
 * Cached dynamic import of the light CANVAS player. Keeps lottie out of the
 * main inbox bundle; the promise is shared so scrolling through a sticker-heavy
 * thread never re-imports the module.
 */
let lottiePromise: Promise<LottiePlayer> | null = null
function getLottie(): Promise<LottiePlayer> {
  if (!lottiePromise) {
    lottiePromise = import('lottie-web/build/player/lottie_light_canvas').then(
      (m) => (m as unknown as { default: LottiePlayer }).default,
    )
  }
  return lottiePromise
}

/**
 * Decoded Lottie JSON cache keyed by media URL, plus an in-flight map so two
 * stickers with the same URL (or a quick scroll away and back) don't decode
 * twice. Capped to bound memory on very long threads.
 */
const animCache = new Map<string, unknown>()
const inflight = new Map<string, Promise<unknown>>()
const ANIM_CACHE_MAX = 80

function cacheAnim(url: string, data: unknown) {
  if (!animCache.has(url) && animCache.size >= ANIM_CACHE_MAX) {
    const oldest = animCache.keys().next().value
    if (oldest !== undefined) animCache.delete(oldest)
  }
  animCache.set(url, data)
}

async function loadAnimationData(url: string): Promise<unknown> {
  const cached = animCache.get(url)
  if (cached) return cached
  const existing = inflight.get(url)
  if (existing) return existing
  const p = (async () => {
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`status ${res.status}`)
    // TGS = gzip-compressed Lottie JSON. DecompressionStream is available in
    // every modern browser, so no gunzip dependency is needed.
    const stream = res.body.pipeThrough(new DecompressionStream('gzip'))
    const json = await new Response(stream).json()
    cacheAnim(url, json)
    return json
  })()
  inflight.set(url, p)
  try {
    return await p
  } finally {
    inflight.delete(url)
  }
}

export function TgsSticker({ url, alt, onError, onLoad }: TgsStickerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    let anim: LottieAnim | null = null
    let io: IntersectionObserver | null = null

    async function start() {
      try {
        // Fetch/decode and load the player in parallel — both are cached.
        const [data, lottie] = await Promise.all([
          loadAnimationData(url),
          getLottie(),
        ])
        if (!cancelled) onLoad?.()
        if (cancelled || !containerRef.current) return
        anim = lottie.loadAnimation({
          container: containerRef.current,
          renderer: 'canvas',
          loop: true,
          // Start paused: the IntersectionObserver below plays it only while
          // it is actually on screen.
          autoplay: false,
          animationData: data,
          rendererSettings: {
            clearCanvas: true,
            // A 128px sticker doesn't need retina-squared raster work; cap the
            // device pixel ratio to keep the canvas cheap on HiDPI screens.
            dpr: Math.min(
              typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
              2,
            ),
          },
        })
        setReady(true)

        const el = containerRef.current
        io = new IntersectionObserver(
          (entries) => {
            if (!anim) return
            if (entries.some((e) => e.isIntersecting)) anim.play()
            else anim.pause()
          },
          { rootMargin: '100px' },
        )
        io.observe(el)
      } catch {
        if (!cancelled) onError()
      }
    }

    void start()
    return () => {
      cancelled = true
      io?.disconnect()
      anim?.destroy()
    }
  }, [url, onError, onLoad])

  return (
    <div className="relative size-32" role="img" aria-label={alt}>
      {!ready ? (
        <span className="absolute inset-0 flex items-center justify-center text-5xl leading-none">
          {alt || '🎯'}
        </span>
      ) : null}
      <div ref={containerRef} className="size-full" />
    </div>
  )
}
