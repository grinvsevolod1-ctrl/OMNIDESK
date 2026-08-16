'use client'

/**
 * Local, in-tab notifications for the manager inbox: a short sound and a
 * flashing tab title when a new inbound message arrives. Complements Web Push
 * (which covers closed tabs but needs permission and often gets blocked) with
 * zero-permission feedback in the open tab.
 *
 * The sound is synthesized with WebAudio — no audio asset to load, nothing to
 * 404, works offline. Preference persists in localStorage and is shared by
 * every inbox tab of this browser.
 */

const SOUND_PREF_KEY = 'omnidesk:notify-sound'

export function isSoundEnabled(): boolean {
  if (typeof window === 'undefined') return false
  // Default ON: the whole point is that managers stop missing messages.
  return window.localStorage.getItem(SOUND_PREF_KEY) !== 'off'
}

export function setSoundEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SOUND_PREF_KEY, enabled ? 'on' : 'off')
}

let audioCtx: AudioContext | null = null

/**
 * Play a short two-tone chime. Browsers block audio before the first user
 * gesture — failures are swallowed (the manager has interacted with the inbox
 * in any real session, so in practice it plays).
 */
export function playNotificationSound(): void {
  if (!isSoundEnabled() || typeof window === 'undefined') return
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!Ctx) return
    audioCtx ??= new Ctx()
    if (audioCtx.state === 'suspended') {
      void audioCtx.resume().catch(() => {})
    }
    const now = audioCtx.currentTime
    const gain = audioCtx.createGain()
    gain.connect(audioCtx.destination)
    // Gentle envelope: quick attack, ~0.35s decay — noticeable, not jarring.
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4)
    const osc = audioCtx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, now) // A5
    osc.frequency.setValueAtTime(1174.66, now + 0.12) // D6
    osc.connect(gain)
    osc.start(now)
    osc.stop(now + 0.45)
  } catch {
    /* audio blocked or unavailable — silent no-op */
  }
}

let titleFlashTimer: ReturnType<typeof setInterval> | null = null
let originalTitle: string | null = null
let focusListenerAttached = false

function stopTitleFlash(): void {
  if (titleFlashTimer) {
    clearInterval(titleFlashTimer)
    titleFlashTimer = null
  }
  if (originalTitle !== null) {
    document.title = originalTitle
    originalTitle = null
  }
}

/**
 * Flash the tab title with the unread hint until the manager focuses the tab.
 * No-op when the tab is already visible and focused (they can see the inbox).
 */
export function flashTabTitle(text = 'Новое сообщение'): void {
  if (typeof document === 'undefined') return
  if (!document.hidden && document.hasFocus()) return
  if (!focusListenerAttached) {
    focusListenerAttached = true
    window.addEventListener('focus', stopTitleFlash)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) stopTitleFlash()
    })
  }
  if (titleFlashTimer) return // already flashing
  originalTitle = document.title
  let shown = false
  titleFlashTimer = setInterval(() => {
    shown = !shown
    document.title = shown ? `● ${text}` : (originalTitle ?? document.title)
  }, 1_000)
}

/** One call for the inbox: chime + flash, both respecting their own guards. */
export function notifyNewInboundMessage(): void {
  playNotificationSound()
  flashTabTitle()
}
