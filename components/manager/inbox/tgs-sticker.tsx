'use client'

/**
 * Renderer for Telegram's animated TGS stickers (gzipped Lottie JSON).
 * An <img> cannot display these — which is why animated stickers used to
 * degrade to the "[Стикер]" text fallback. We fetch the raw bytes, gunzip
 * them with the browser-native DecompressionStream (no extra dependency),
 * and play the animation with lottie-web's canvas renderer.
 */

import { useEffect, useRef, useState } from 'react'

interface TgsStickerProps {
  /** Same-origin URL streaming the raw .tgs bytes (e.g. /api/media/{id}). */
  url: string
  /** Emoji/alt fallback shown while loading or if decoding fails. */
  alt: string
  /** Notify the parent that decoding failed so it can render its fallback. */
  onError: () => void
}

export function TgsSticker({ url, alt, onError }: TgsStickerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    let anim: { destroy: () => void } | null = null

    async function load() {
      try {
        const res = await fetch(url)
        if (!res.ok || !res.body) throw new Error(`status ${res.status}`)
        // TGS = gzip-compressed Lottie JSON. DecompressionStream is available
        // in every modern browser, so no gunzip dependency is needed.
        const stream = res.body.pipeThrough(new DecompressionStream('gzip'))
        const json = await new Response(stream).json()
        if (cancelled || !containerRef.current) return
        // Dynamic import keeps lottie-web out of the main inbox bundle; the
        // light build has no expression evaluator (smaller and safer).
        const lottie = (await import('lottie-web/build/player/lottie_light'))
          .default
        if (cancelled || !containerRef.current) return
        anim = lottie.loadAnimation({
          container: containerRef.current,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          animationData: json,
        })
        setReady(true)
      } catch {
        if (!cancelled) onError()
      }
    }

    void load()
    return () => {
      cancelled = true
      anim?.destroy()
    }
  }, [url, onError])

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
