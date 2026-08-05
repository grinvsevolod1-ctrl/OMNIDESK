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

/**
 * How many top-of-list threads get their transcript in the SSR payload.
 * Covers a full screen of the list plus healthy overscroll; everything
 * below lazy-loads on first open.
 */
const INBOX_PRELOAD_THREADS = 40

/**
 * Minimum time an account must stay degraded before the manager sees the
 * "needs attention" banner. Routine reconnects recover in seconds and were
 * pure noise; only a persistent outage is actionable for a manager.
 */
const DEGRADED_GRACE_MS = 5 * 60_000

/**
 * True when the channel has been in a degraded session state for longer than
 * the grace period. Missing timestamp (migration not applied yet) counts as
 * NOT degraded-long-enough — stay quiet rather than nag about a blip.
 * Server-only helper: reads the clock, so it lives outside component render.
 */
function isDegradedPastGrace(c: {
  type: string
  sessionStatus: string | null
  sessionStatusChangedAt: string | null
}): boolean {
  if (c.type !== 'telegram' && c.type !== 'whatsapp') return false
  if (
    c.sessionStatus !== 'rate_limited' &&
    c.sessionStatus !== 'error' &&
    c.sessionStatus !== 'logged_out' &&
    c.sessionStatus !== 'offline'
  ) {
    return false
  }
  if (!c.sessionStatusChangedAt) return false
  return (
    Date.now() - new Date(c.sessionStatusChangedAt).getTime() >=
    DEGRADED_GRACE_MS
  )
}

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

  // Personal accounts whose session has been degraded past the grace period —
  // surfaced as a banner in the inbox (see isDegradedPastGrace for the rules).
  const degradedAccounts = channels
    .filter(isDegradedPastGrace)
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      sessionStatus: c.sessionStatus,
      lastError: c.lastError,
    }))

  // Recent transcripts in ONE window-function query — but only for the top
  // slice of the list (sorted by last activity). A busy panel holds up to 500
  // threads; preloading all of them serialized thousands of rows into the RSC
  // payload while the manager physically sees ~15. Threads outside the slice
  // lazy-load on первый клик via loadThreadMessagesAction; missing keys mark
  // them as "not yet loaded" for the client.
  const preloadIds = conversations
    .slice(0, INBOX_PRELOAD_THREADS)
    .map((c) => c.id)
  const batched = await listMessagesForConversations(preloadIds, session.sub)
  const messagesByConversation: Record<string, Message[]> = {}
  for (const id of preloadIds) {
    messagesByConversation[id] = batched[id] ?? []
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
