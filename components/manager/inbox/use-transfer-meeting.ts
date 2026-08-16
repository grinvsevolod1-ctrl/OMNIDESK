'use client'

import { useCallback, useState } from 'react'
import type { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  createMeetingAction,
  transferConversationAction,
} from '@/app/actions/conversations'

/**
 * Передача диалога коллеге (диалоговое окно + сабмит) и создание
 * Telemost-встречи. Вынесено из inbox-view: 6 useState и 3 функции.
 */
export function useTransferMeeting({
  router,
  activeId,
  setActiveId,
  startStatusTransition,
}: {
  router: ReturnType<typeof useRouter>
  activeId: string | null
  setActiveId: (id: string | null) => void
  startStatusTransition: (fn: () => Promise<void>) => void
}) {
  // Conversation hand-off dialog state. `transferForId` holds the conversation
  // being handed off (null = dialog closed); the picker/note drive the submit.
  const [transferForId, setTransferForId] = useState<string | null>(null)
  const [transferTo, setTransferTo] = useState('')
  const [transferNote, setTransferNote] = useState('')
  const [transferPending, setTransferPending] = useState(false)
  // Telemost video-meeting creation in progress (disables the composer button).
  const [meetingPending, setMeetingPending] = useState(false)

  // Open the hand-off dialog for a conversation, resetting the picker/note.
  const openTransfer = useCallback((conversationId: string) => {
    setTransferForId(conversationId)
    setTransferTo('')
    setTransferNote('')
  }, [])

  // Submit the hand-off. On success the thread leaves this manager's inbox, so
  // we close it and refresh the server data.
  const submitTransfer = useCallback(() => {
    if (!transferForId || !transferTo) {
      toast.error('Выберите менеджера для передачи.')
      return
    }
    const convId = transferForId
    setTransferPending(true)
    startStatusTransition(async () => {
      const res = await transferConversationAction(
        convId,
        transferTo,
        transferNote.trim() || undefined,
      )
      setTransferPending(false)
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      setTransferForId(null)
      if (activeId === convId) setActiveId(null)
      router.refresh()
    })
  }, [
    transferForId,
    transferTo,
    transferNote,
    activeId,
    setActiveId,
    router,
    startStatusTransition,
  ])

  // Create a Yandex Telemost meeting and send the join link into the active
  // conversation via its own channel (handled server-side).
  const startVideoMeeting = useCallback(() => {
    if (!activeId || meetingPending) return
    const convId = activeId
    setMeetingPending(true)
    startStatusTransition(async () => {
      const res = await createMeetingAction(convId)
      setMeetingPending(false)
      if (!res.ok) {
        // If the meeting was created but delivery failed, offer the link so it
        // isn't lost.
        if (res.joinUrl) {
          navigator.clipboard?.writeText(res.joinUrl).catch(() => {})
          toast.error(`${res.message} Ссылка скопирована в буфер обмена.`)
        } else {
          toast.error(res.message)
        }
        return
      }
      toast.success(res.message)
      // No router.refresh(): the meeting-link message lands in the thread via
      // the SSE stream like any other outbound message.
    })
  }, [activeId, meetingPending, startStatusTransition])

  return {
    transferForId,
    setTransferForId,
    transferTo,
    setTransferTo,
    transferNote,
    setTransferNote,
    transferPending,
    meetingPending,
    openTransfer,
    submitTransfer,
    startVideoMeeting,
  }
}
