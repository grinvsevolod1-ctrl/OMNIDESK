'use client'

/**
 * Состояние раздела «Чаты» куратора: выбор активного диалога, локальный кэш
 * сообщений, реалтайм через общий /api/stream (события уже приходят
 * скоупленные по curator_id — см. app/api/stream) и ПОЛНЫЙ набор действий
 * менеджера над сообщениями.
 *
 * Сами действия и загрузка истории — ОБЩИЕ с менеджером
 * (`components/shared/inbox/*`); роль подключается через
 * `curatorThreadAdapter`, который подставляет curator-scoped серверные экшены
 * (см. app/actions/curator-messages). Здесь остаётся только то, что у
 * куратора действительно своё: выбор диалога, кэш, «прочитано», цели пересылки.
 */

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { Conversation, Message } from '@/lib/types'
import type { ForwardTarget } from '@/components/manager/message-context-menu'
import { useInboxRealtime } from '@/components/manager/inbox/use-inbox-realtime'
import { useMessageActions } from '@/components/shared/inbox/use-message-actions'
import { useThreadHistory } from '@/components/shared/inbox/use-thread-history'
import { mergeFreshSlices } from '@/lib/merge-thread-slice'
import { markCuratorConversationReadAction } from '@/app/actions/curator-messages'
import { curatorThreadAdapter } from './curator-thread-adapter'

export function useCuratorChats({
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

  const [activeId, setActiveId] = useState<string | null>(
    conversations[0]?.id ?? null,
  )
  const [localMessages, setLocalMessages] = useState<
    Record<string, Message[]>
  >(messagesByConversation)

  // Держим локальный кэш в синхроне с новыми SSR-данными (router.refresh).
  // СЛИЯНИЕ, не замена: свежий срез — это только последние ~30 сообщений, а
  // куратор мог долистать историю на сотни назад (см. lib/merge-thread-slice).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalMessages((prev) => mergeFreshSlices(prev, messagesByConversation))
  }, [messagesByConversation])

  const { syncState } = useInboxRealtime({ router, setLocalMessages })

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  )
  const thread = activeId ? (localMessages[activeId] ?? []) : []

  // Холодный диалог (вне SSR-слайса) и «Загрузить ранние» — общий хук.
  const { threadLoading, loadingOlder, noOlder, handleLoadOlder } =
    useThreadHistory({
      adapter: curatorThreadAdapter,
      activeId,
      localMessages,
      setLocalMessages,
    })

  // Отметить прочитанным при открытии (best-effort).
  useEffect(() => {
    if (!activeId) return
    void markCuratorConversationReadAction(activeId).catch(() => {})
  }, [activeId])

  // Все действия над сообщениями — общий хук; куратор без AI-гейта (диалог
  // уже передан человеку, ИИ по нему молчит по `curator_id IS NULL`).
  const actions = useMessageActions({
    adapter: curatorThreadAdapter,
    activeId,
    active,
    currentUser,
    setLocalMessages,
    startTransition,
  })

  // Цели пересылки: остальные переданные куратору Telegram-диалоги.
  const forwardTargets: ForwardTarget[] = useMemo(
    () =>
      conversations
        .filter((c) => c.channelType === 'telegram' && c.id !== activeId)
        .map((c) => ({ id: c.id, name: c.contactName })),
    [conversations, activeId],
  )

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
    forwardTargets,
    pending,
    syncState,
  }
}
