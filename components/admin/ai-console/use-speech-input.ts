'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/* ------------------------------ Voice input ----------------------------- */

export interface SpeechInput {
  supported: boolean
  listening: boolean
  toggle: () => void
}

/**
 * Thin wrapper over the Web Speech API (ru-RU). Streams interim results into the
 * composer as you speak and auto-submits the final phrase — so it feels like
 * talking to Siri. Degrades to `supported: false` where the API is missing (e.g.
 * Firefox), and the mic button is simply not rendered.
 */
export function useSpeechInput({
  onInterim,
  onFinal,
}: {
  onInterim: (text: string) => void
  onFinal: (text: string) => void
}): SpeechInput {
  const [supported, setSupported] = useState(false)
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const onInterimRef = useRef(onInterim)
  const onFinalRef = useRef(onFinal)

  // Keep the latest callbacks in refs without writing during render.
  useEffect(() => {
    onInterimRef.current = onInterim
    onFinalRef.current = onFinal
  }, [onInterim, onFinal])

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
    rec.onresult = (e: SpeechRecognitionEventLike) => {
      let interim = ''
      let final = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        const transcript = result[0]?.transcript ?? ''
        if (result.isFinal) final += transcript
        else interim += transcript
      }
      if (interim) onInterimRef.current(interim)
      const trimmed = final.trim()
      if (trimmed) onFinalRef.current(trimmed)
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    recognitionRef.current = rec

    return () => {
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
      try {
        rec.stop()
      } catch {
        /* ignore */
      }
      setListening(false)
      return
    }
    try {
      rec.start()
      setListening(true)
    } catch {
      setListening(false)
    }
  }, [listening])

  return useMemo(
    () => ({ supported, listening, toggle }),
    [supported, listening, toggle],
  )
}

/* Minimal typings for the non-standard Web Speech API (avoids `any`). */
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  start: () => void
  stop: () => void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}
interface SpeechRecognitionResultLike extends ArrayLike<{ transcript: string }> {
  isFinal: boolean
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<SpeechRecognitionResultLike>
}
interface WindowWithSpeech extends Window {
  SpeechRecognition?: new () => SpeechRecognitionLike
  webkitSpeechRecognition?: new () => SpeechRecognitionLike
}
