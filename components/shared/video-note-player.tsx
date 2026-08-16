'use client'

/**
 * Телеграм-стиль плеер «кружка» (video note): круглое видео, клик —
 * play/pause, живой круговой прогресс-бар по ободу кружка (как в официальном
 * клиенте), счётчик оставшегося времени и иконка состояния по центру.
 *
 * Прогресс рисуется через requestAnimationFrame, а не timeupdate: событие
 * timeupdate стреляет ~4 раза в секунду и обод дёргается ступеньками; rAF
 * даёт плавное движение ровно пока идёт воспроизведение.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Pause, Play } from 'lucide-react'
import { cn } from '@/lib/utils'

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function VideoNotePlayer({
  src,
  size = 192,
  className,
  autoPlay = false,
  onError,
}: {
  src: string
  /** Диаметр кружка в px. */
  size?: number
  className?: string
  /** Автозапуск (используется в лайтбоксе/просмотре перед удалением). */
  autoPlay?: boolean
  onError?: () => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const rafRef = useRef<number>(0)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0) // 0..1
  const [remaining, setRemaining] = useState<number | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  // Иконка по центру видна: до первого запуска, на паузе и при ховере.
  const [hovered, setHovered] = useState(false)
  const [started, setStarted] = useState(false)

  // Плавный прогресс через rAF, только пока играет.
  useEffect(() => {
    if (!playing) return
    const tick = () => {
      const v = videoRef.current
      if (v && v.duration > 0) {
        setProgress(v.currentTime / v.duration)
        setRemaining(v.duration - v.currentTime)
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing])

  const toggle = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      setStarted(true)
      void v.play().catch(() => {})
    } else {
      v.pause()
    }
  }, [])

  // Геометрия обода: SVG-кольцо чуть внутри края кружка.
  const stroke = Math.max(2.5, size / 64)
  const r = size / 2 - stroke / 2 - 1
  const circumference = 2 * Math.PI * r

  const label = playing
    ? 'Пауза'
    : started
      ? 'Продолжить воспроизведение'
      : 'Воспроизвести видеосообщение'

  return (
    <button
      type="button"
      onClick={toggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        'group relative block shrink-0 select-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      style={{ width: size, height: size }}
      aria-label={label}
    >
      <video
        ref={videoRef}
        src={src}
        playsInline
        autoPlay={autoPlay}
        // preload=metadata: длительность видна сразу, байты не тянем зря.
        preload="metadata"
        className="pointer-events-none size-full rounded-full object-cover"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          if (Number.isFinite(v.duration)) {
            setDuration(v.duration)
            setRemaining(v.duration)
          }
        }}
        onPlay={() => {
          setStarted(true)
          setPlaying(true)
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setProgress(0)
          if (videoRef.current) videoRef.current.currentTime = 0
          setRemaining(duration)
        }}
        onError={onError}
      />

      {/* Живой прогресс-обод — поверх видео, как в Telegram. */}
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="pointer-events-none absolute inset-0 -rotate-90"
        aria-hidden="true"
      >
        {/* Тонкая подложка обода, видна всегда после старта. */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.25)"
          strokeWidth={stroke}
          className={cn(
            'transition-opacity duration-300',
            started ? 'opacity-100' : 'opacity-0',
          )}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="white"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          className={cn(
            'transition-opacity duration-300',
            started ? 'opacity-100' : 'opacity-0',
          )}
          style={{ filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.5))' }}
        />
      </svg>

      {/* Центральная иконка: до старта и на паузе — всегда; при игре — на ховере. */}
      <span
        className={cn(
          'pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-150',
          playing ? (hovered ? 'opacity-100' : 'opacity-0') : 'opacity-100',
        )}
      >
        <span className="flex size-12 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-[2px]">
          {playing ? (
            <Pause className="size-5 fill-current" />
          ) : (
            <Play className="ml-0.5 size-5 fill-current" />
          )}
        </span>
      </span>

      {/* Бейдж времени внутри кружка снизу — оставшееся время, как в TG. */}
      {remaining != null ? (
        <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white backdrop-blur-[2px]">
          {formatClock(remaining)}
        </span>
      ) : null}
    </button>
  )
}
