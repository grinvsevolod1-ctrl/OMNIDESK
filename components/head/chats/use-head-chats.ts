'use client'

/**
 * Состояние раздела «Диалоги» руководителя: активный диалог, локальный кэш
 * сообщений, реалтайм через общий /api/stream (события приходят уже
 * отфильтрованные по кураторам его команд — см. app/api/stream) и лоадеры
 * истории из общего ядра инбокса. Никаких действий над перепиской: роль
 * только смотрит. «Прочитано» тоже НЕ ставим — счётчик непрочитанного
 * принадлежит куратору, руководитель его не сбивает.
 */

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { Conversation, Message } from '@/lib/types'
import { useInboxRealtime } from '@/components/manager/inbox/use-inbox-realtime'
import { useMessageActions } from '@/components/shared/inbox/use-message-actions'
import { useThreadHistory } from '@/components/shared/inbox/use-thread-history'
import { mergeFreshSlices } from '@/lib/merge-thread-slice'
import { headThreadAdapter } from './head-thread-adapter'

export function useHeadChats({
  conversations,
  messagesByConversation,
  currentUser,
}: {
  conversations: Conversation[]
  messagesByConversation: Record<string, Message[]>
  currentUser: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  // Руководитель выбирает диалог сам — по умолчанию ничего не открыто, чтобы
  // сначала показать выбор куратора/поиск, а не случайный первый тред.
  const [activeId, setActiveId] = useState<string | null>(null)
  const [localMessages, setLocalMessages] = useState<
    Record<string, Message[]>
  >(messagesByConversation)

  // СЛИЯНИЕ свежих SSR-срезов с локальным кэшем (см. lib/merge-thread-slice):
  // router.refresh() по realtime-тику несёт только последние ~30 сообщений.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalMessages((prev) => mergeFreshSlices(prev, messagesByConversation))
  }, [messagesByConversation])

  const { syncState } = useInboxRealtime({
    router,
    setLocalMessages,
    activeId,
    loadThread: headThreadAdapter.loadThread,
  })

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  )
  const thread = activeId ? (localMessages[activeId] ?? []) : []

  const { threadLoading, loadingOlder, noOlder, handleLoadOlder } =
    useThreadHistory({
      adapter: headThreadAdapter,
      activeId,
      localMessages,
      setLocalMessages,
    })

  // Общий хук действий нужен ThreadPane ради «Копировать» и состояния
  // баннеров; все мутации адаптера закорочены на отказ (head-thread-adapter).
  const actions = useMessageActions({
    adapter: headThreadAdapter,
    activeId,
    active,
    currentUser,
    canSend: () => false,
    setLocalMessages,
    startTransition,
  })

  return {
    activeId,
    setActiveId,
    active,
    thread,
    threadLoading,
    loadingOlder,
    noOlder,
    loadOlder: handleLoadOlder,
    actions,
    pending,
    syncState,
  }
}
