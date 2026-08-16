'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/* ------------------------------ Voice input ----------------------------- */

/** Why recognition stopped/failed — mapped to a friendly message by the caller. */
export type SpeechErrorCode =
  | 'not-allowed'
  | 'no-speech'
  | 'audio-capture'
  | 'network'
  | 'aborted'
  | 'unknown'

export interface SpeechInput {
  supported: boolean
  listening: boolean
  toggle: () => void
}

/**
 * Thin wrapper over the Web Speech API (ru-RU). Streams interim results into the
 * composer as you speak and submits the final phrase once you pause — so it
 * feels like talking to Siri. Degrades to `supported: false` where the API is
 * missing (e.g. Firefox), and the mic button is simply not rendered.
 *
 * Design notes that make it actually reliable:
 *  - We submit exactly once, from `onend`, using the transcript accumulated for
 *    the session — never from inside `onresult`. Submitting per final segment
 *    races the still-open recogniser and drops words when the caller flips to a
 *    busy/`loading` state mid-utterance.
 *  - `listening` mirrors the real recogniser via `onstart`/`onend`, not an
 *    optimistic flag set before the mic actually opens.
 *  - Errors (denied mic permission, no speech, a preview iframe without a
 *    `microphone` permission-policy) are surfaced through `onError` so the UI
 *    can explain why nothing happened instead of silently doing nothing.
 */
export function useSpeechInput({
  onInterim,
  onFinal,
  onError,
}: {
  onInterim: (text: string) => void
  onFinal: (text: string) => void
  onError?: (code: SpeechErrorCode) => void
}): SpeechInput {
  const [supported, setSupported] = useState(false)
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  // Final transcript accumulated across all result events of one session, so a
  // multi-part phrase ("выключи ии-менеджера … и сбрось агрессивность") arrives
  // whole in a single submit on `onend`.
  const finalRef = useRef('')
  const onInterimRef = useRef(onInterim)
  const onFinalRef = useRef(onFinal)
  const onErrorRef = useRef(onError)

  // Keep the latest callbacks in refs without writing during render, so the
  // recogniser (created once) always calls the current closures.
  useEffect(() => {
    onInterimRef.current = onInterim
    onFinalRef.current = onFinal
    onErrorRef.current = onError
  }, [onInterim, onFinal, onError])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const Ctor =
      (window as WindowWithSpeech).SpeechRecognition ||
      (window as WindowWithSpeech).webkitSpeechRecognition
    if (!Ctor) return
    // Capability detection must happen after mount (window isn't available
    // during SSR, and a lazy render-time read would cause a hydration
    // mismatch). This effect genuinely wires up the SpeechRecognition external
    // system, so the one-shot setState here is the intended pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(true)

    const rec = new Ctor()
    rec.lang = 'ru-RU'
    rec.interimResults = true
    rec.maxAlternatives = 1

    rec.onstart = () => setListening(true)

    rec.onresult = (e: SpeechRecognitionEventLike) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        const transcript = result[0]?.transcript ?? ''
        if (result.isFinal) finalRef.current += transcript
        else interim += transcript
      }
      // Live preview = everything finalised so far plus the in-flight guess.
      const preview = (finalRef.current + interim).trim()
      if (preview) onInterimRef.current(preview)
    }

    rec.onerror = (e: SpeechRecognitionErrorEventLike) => {
      onErrorRef.current?.(normalizeError(e?.error))
      setListening(false)
    }

    // Single, guaranteed submit point. Fires on a natural pause (interimResults
    // + non-continuous) or when the user taps the mic to stop.
    rec.onend = () => {
      setListening(false)
      const text = finalRef.current.trim()
      finalRef.current = ''
      if (text) onFinalRef.current(text)
    }

    recognitionRef.current = rec

    return () => {
      rec.onstart = null
      rec.onresult = null
      rec.onerror = null
      rec.onend = null
      try {
        rec.stop()
      } catch {
        /* ignore */
      }
      recognitionRef.current = null
    }
  }, [])

  const toggle = useCallback(() => {
    const rec = recognitionRef.current
    if (!rec) return
    if (listening) {
      // Stop → `onend` fires → the accumulated phrase is submitted.
      try {
        rec.stop()
      } catch {
        /* ignore */
      }
      return
    }
    // Fresh session: clear any leftover transcript, then start. `listening` is
    // set by `onstart` once the mic is actually open (accurate state); if start
    // throws (e.g. already running) we surface it rather than lie about state.
    finalRef.current = ''
    try {
      rec.start()
    } catch {
      onErrorRef.current?.('unknown')
    }
  }, [listening])

  return useMemo(
    () => ({ supported, listening, toggle }),
    [supported, listening, toggle],
  )
}

/** Map a raw Web Speech error string to our small, stable union. */
function normalizeError(raw: string | undefined): SpeechErrorCode {
  switch (raw) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'not-allowed'
    case 'no-speech':
      return 'no-speech'
    case 'audio-capture':
      return 'audio-capture'
    case 'network':
      return 'network'
    case 'aborted':
      return 'aborted'
    default:
      return 'unknown'
  }
}

/* Minimal typings for the non-standard Web Speech API (avoids `any`). */
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  start: () => void
  stop: () => void
  onstart: (() => void) | null
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null
}
interface SpeechRecognitionResultLike extends ArrayLike<{ transcript: string }> {
  isFinal: boolean
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<SpeechRecognitionResultLike>
}
interface SpeechRecognitionErrorEventLike {
  error?: string
}
interface WindowWithSpeech extends Window {
  SpeechRecognition?: new () => SpeechRecognitionLike
  webkitSpeechRecognition?: new () => SpeechRecognitionLike
}
