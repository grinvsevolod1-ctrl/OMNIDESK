'use client'

/**
 * Voice-note recorder for the inbox composer (Telegram only). One button:
 * tap to start recording (MediaRecorder → opus), tap again to stop & send,
 * or cancel with the X. While recording the composer row shows a red pulse
 * and a running timer instead of silently capturing audio.
 *
 * Kept deliberately dependency-free: no waveform rendering, no preview
 * playback — record → send, like the mobile messenger flow managers know.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** Max recording length; matches the server action's ~1 MB payload cap. */
const MAX_SECONDS = 90

export interface VoiceRecorderProps {
  disabled?: boolean
  /** Called with the encoded audio when the manager stops the recording. */
  onSend: (audio: { base64: string; mime: string; durationSec: number }) => void
  /** Fired when mic access fails, with a human-readable reason. */
  onError: (message: string) => void
}

/** Pick the best audio container the browser can record. Telegram voice
 *  bubbles want OGG/Opus; Chrome records webm/opus (Telegram still renders it
 *  as a voice message since the codec is opus), Safari falls back to mp4. */
function pickMime(): string {
  const candidates = [
    'audio/ogg;codecs=opus',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ]
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) {
      return c
    }
  }
  return ''
}

export function VoiceRecorder({ disabled, onSend, onError }: VoiceRecorderProps) {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const startedAtRef = useRef(0)
  const cancelledRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onSendRef = useRef(onSend)
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onSendRef.current = onSend
    onErrorRef.current = onError
  }, [onSend, onError])

  const teardown = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    recorderRef.current = null
    setRecording(false)
    setSeconds(0)
  }, [])

  // Never leave the mic open if the component unmounts mid-recording
  // (switching conversations, closing the thread).
  useEffect(() => {
    return () => {
      cancelledRef.current = true
      try {
        recorderRef.current?.stop()
      } catch {
        /* already stopped */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop())
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  const start = useCallback(async () => {
    if (recording) return
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      onErrorRef.current(
        'Нет доступа к микрофону. Разрешите доступ в настройках браузера.',
      )
      return
    }
    const mime = pickMime()
    let rec: MediaRecorder
    // Cap the encoder bitrate: Chrome's default (~128 kbps) would push a full
    // 90s recording to ~1.4 MB — over the server's 1 MB payload cap, rejecting
    // a recording the manager already made. 32 kbps opus is plenty for speech
    // (Telegram voice notes use similar) and keeps 90s ≈ 360 KB.
    const options: MediaRecorderOptions = { audioBitsPerSecond: 32_000 }
    if (mime) options.mimeType = mime
    try {
      rec = new MediaRecorder(stream, options)
    } catch {
      stream.getTracks().forEach((t) => t.stop())
      onErrorRef.current('Браузер не поддерживает запись аудио.')
      return
    }
    chunksRef.current = []
    cancelledRef.current = false
    startedAtRef.current = Date.now()
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }
    rec.onstop = () => {
      const durationSec = Math.round((Date.now() - startedAtRef.current) / 1000)
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
      chunksRef.current = []
      const wasCancelled = cancelledRef.current
      teardown()
      if (wasCancelled || blob.size === 0 || durationSec < 1) return
      // Blob → base64 for the server action (payload travels through the
      // Postgres job queue, so it must be JSON-safe).
      const reader = new FileReader()
      reader.onloadend = () => {
        const dataUrl = String(reader.result || '')
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
        if (base64) {
          onSendRef.current({ base64, mime: blob.type, durationSec })
        }
      }
      reader.readAsDataURL(blob)
    }
    recorderRef.current = rec
    streamRef.current = stream
    rec.start()
    setRecording(true)
    setSeconds(0)
    timerRef.current = setInterval(() => {
      setSeconds((s) => {
        // Auto-stop at the cap so the payload can never exceed the server limit.
        if (s + 1 >= MAX_SECONDS) {
          try {
            recorderRef.current?.stop()
          } catch {
            /* already stopped */
          }
        }
        return s + 1
      })
    }, 1000)
  }, [recording, teardown])

  const stopAndSend = useCallback(() => {
    cancelledRef.current = false
    try {
      recorderRef.current?.stop()
    } catch {
      teardown()
    }
  }, [teardown])

  const cancel = useCallback(() => {
    cancelledRef.current = true
    try {
      recorderRef.current?.stop()
    } catch {
      teardown()
    }
  }, [teardown])

  const mm = String(Math.floor(seconds / 60)).padStart(1, '0')
  const ss = String(seconds % 60).padStart(2, '0')

  if (recording) {
    return (
      <div className="flex shrink-0 items-center gap-1 rounded-full bg-destructive/10 pl-2.5">
        <span
          className="size-2 animate-pulse rounded-full bg-destructive"
          aria-hidden="true"
        />
        <span className="text-xs font-medium tabular-nums text-destructive">
          {mm}:{ss}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 rounded-full text-muted-foreground hover:text-foreground"
          onClick={cancel}
          aria-label="Отменить запись"
          title="Отменить запись"
        >
          <X className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          className="size-10 rounded-full"
          onClick={stopAndSend}
          aria-label="Остановить и отправить"
          title="Остановить и отправить"
        >
          <Square className="size-4" />
        </Button>
      </div>
    )
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        'size-10 shrink-0 rounded-full text-muted-foreground hover:text-foreground',
      )}
      disabled={disabled}
      onClick={start}
      aria-label="Записать голосовое сообщение"
      title="Записать голосовое сообщение"
    >
      <Mic className="size-4" />
    </Button>
  )
}
