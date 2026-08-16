'use client'

import { useCallback, useRef } from 'react'

/**
 * Per-conversation composer drafts. Like Telegram, an unsent message is kept
 * when you switch to another conversation and restored when you come back.
 *
 * Kept in a ref (not state) so the MessageComposer — which is keyed by
 * conversation id and owns the live text in local state — can seed from and
 * write back to it WITHOUT ever re-rendering the large inbox container on a
 * keystroke.
 *
 * Drafts are ALSO mirrored to localStorage: the in-memory ref dies with the
 * component (router.refresh storms, navigating away via a notification, a
 * full reload, a crash), and losing a half-written reply is exactly the
 * "текст исчезает" complaint. localStorage survives all of those. This is
 * ephemeral UI state (like Telegram Web's drafts), not app data.
 */
export function useDrafts() {
  const draftsRef = useRef<Record<string, string>>({})

  const persistDraft = useCallback((id: string, text: string) => {
    if (text) draftsRef.current[id] = text
    else delete draftsRef.current[id]
    try {
      if (text) localStorage.setItem(`od_draft_${id}`, text)
      else localStorage.removeItem(`od_draft_${id}`)
    } catch {
      // Storage full / privacy mode — the in-memory copy still works.
    }
  }, [])

  const getDraft = useCallback((id: string) => {
    const inMemory = draftsRef.current[id]
    if (inMemory !== undefined) return inMemory
    try {
      return localStorage.getItem(`od_draft_${id}`) ?? ''
    } catch {
      return ''
    }
  }, [])

  return { persistDraft, getDraft }
}
