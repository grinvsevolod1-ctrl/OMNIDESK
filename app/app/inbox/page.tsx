import { Inbox } from 'lucide-react'
import { getAutopilotStatusAction } from '@/app/actions/autopilot'
import { AccountHealthBanner } from '@/components/manager/account-health-banner'
import { InboxView } from '@/components/manager/inbox-view'
import { EmptyState } from '@/components/page-parts'
import { requireManager } from '@/lib/auth'
import {
  listChannels,
  listConversations,
  listMessagesForConversations,
  listQuickReplies,
  listTransferTargets,
} from '@/lib/data'
import { getAiAssistSettings } from '@/lib/data/ai-assist'
import { isTelemostConfigured } from '@/lib/telemost'
import type { Message } from '@/lib/types'

export default async function InboxPage() {
  const session = await requireManager()
  const [conversations, channels, quickReplies, transferTargets] =
    await Promise.all([
      listConversations(session.sub),
      listChannels(session.sub),
      listQuickReplies(session.sub),
      // Colleagues this manager can hand a conversation off to. Best-effort:
      // never let a transfer-target lookup take down the inbox.
      listTransferTargets(session.sub).catch(() => []),
    ])

  // Whether the Yandex Telemost video-meeting button should appear in the
  // composer (only when the admin has configured and enabled it).
  const telemostEnabled = await isTelemostConfigured()

  // Global AI master switch: when on, the AI leads every conversation by default
  // (managers pause individual threads to take over). Drives the inbox's blocked
  // composer + "AI is leading" affordance. Best-effort: default off if the
  // ai_assist tables (migration 054) aren't applied yet.
  let aiMasterEnabled = false
  try {
    aiMasterEnabled = (await getAiAssistSettings()).enabled
  } catch (err) {
    console.error('inbox: AI settings unavailable:', err)
  }

  // Personal accounts whose session is degraded/paused — surfaced as a banner in
  // the inbox so the operator knows live sync may be affected for those sources,
  // without having to open the Connections page.
  const degradedAccounts = channels
    .filter(
      (c) =>
        (c.type === 'telegram' || c.type === 'whatsapp') &&
        (c.sessionStatus === 'rate_limited' ||
          c.sessionStatus === 'error' ||
          c.sessionStatus === 'logged_out' ||
          c.sessionStatus === 'offline'),
    )
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      sessionStatus: c.sessionStatus,
      lastError: c.lastError,
    }))

  // Recent transcript for every visible thread in ONE query (window-function
  // batch) instead of a per-conversation N+1. Threads with no messages are
  // absent from the map, so default them to an empty list for the client.
  const batched = await listMessagesForConversations(
    conversations.map((c) => c.id),
    session.sub,
  )
  const messagesByConversation: Record<string, Message[]> = {}
  for (const c of conversations) {
    messagesByConversation[c.id] = batched[c.id] ?? []
  }

  // Autopilot status for the inbox toolbar toggle. Wrapped in try/catch with
  // safe defaults: if migration 030 (autopilot tables) hasn't been applied yet,
  // a missing-table error must NOT take down the entire inbox.
  let autopilot = { enabled: false, enabledCount: 0 }
  try {
    autopilot = await getAutopilotStatusAction()
  } catch (err) {
    console.error('inbox: autopilot status unavailable:', err)
  }

  return (
    <div className="flex h-full flex-col">
      {degradedAccounts.length > 0 ? (
        <div className="shrink-0 px-3 pt-3 md:px-4">
          <AccountHealthBanner accounts={degradedAccounts} />
        </div>
      ) : null}
      {conversations.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            icon={Inbox}
            title="Входящие пусты"
            description="Как только в подключённые каналы придут сообщения, диалоги появятся здесь."
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <InboxView
            conversations={conversations}
            messagesByConversation={messagesByConversation}
            currentUser={session.name}
            quickReplies={quickReplies}
            autopilot={autopilot}
            aiMasterEnabled={aiMasterEnabled}
            ownedChannelIds={channels.map((c) => c.id)}
            transferTargets={transferTargets}
            telemostEnabled={telemostEnabled}
          />
        </div>
      )}
    </div>
  )
}
