import 'server-only'
import { isConversationMuted } from './data'
import {
  isPushConfigured,
  sendPushToGod,
  sendPushToManager,
  sendPushToVisitor,
} from './push'
import { type RealtimeEvent, subscribeRealtime } from './realtime'

/**
 * Long-lived push dispatcher.
 *
 * Started once on server boot (see instrumentation.ts). It subscribes to the
 * SAME shared realtime hub the SSE inbox uses, so it reuses the single Postgres
 * LISTEN connection — no new subsystem, no extra DB load. For every NEW inbound
 * message it sends a Web Push to that conversation's manager, which means
 * notifications arrive even when no browser tab is open (the whole point of
 * push). Outbound messages, conversation/channel events and history replays are
 * ignored.
 *
 * The subscription is intentionally permanent: keeping one subscriber alive
 * also keeps the realtime hub connected, and it is created exactly once thanks
 * to the globalThis guard below (so hot reloads / double-imports don't stack
 * duplicate listeners that would send the same push twice).
 */

const globalForDispatcher = globalThis as unknown as {
  __pushDispatcherStarted?: boolean
}

function truncate(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean
}

function channelLabel(type?: string): string {
  switch (type) {
    case 'whatsapp':
      return 'WhatsApp'
    case 'telegram':
      return 'Telegram'
    case 'livechat':
      return 'Онлайн-чат'
    case 'max':
      return 'MAX'
    case 'vk':
      return 'VK'
    default:
      return 'Сообщение'
  }
}

/**
 * Notify a website visitor (via the Web Push subscription their browser
 * registered through the host site's service worker) when an operator/autopilot
 * replies in a live-chat thread. Clicking the notification reopens the site
 * hosting the widget — even when no tab is open and even from an installed PWA.
 */
async function handleVisitorReply(event: RealtimeEvent): Promise<void> {
  if (event.channelType !== 'livechat') return
  if (!event.channelId || !event.contactHandle) return

  const handle = event.contactHandle
  const sender = event.author?.trim() || 'Оператор'
  const body = event.body ? truncate(event.body) : 'Новый ответ'

  void sendPushToVisitor(event.channelId, handle, {
    title: sender,
    body,
    // The subscription lives on the visitor's own site (the widget host), so a
    // relative root reopens the page where the chat widget is mounted.
    url: '/',
    tag: `lc:${event.channelId}:${handle}`,
  }).catch(() => {
    /* delivery failures are handled/logged inside sendPushToVisitor */
  })
}

/**
 * Notify the god-messenger (any installed device) when a manager replies in a
 * conversation. From the god messenger's perspective the god "is" the client, so
 * an outbound manager message is an incoming reply worth a push. Clicking it
 * opens the god messenger on that exact conversation.
 */
async function handleGodReply(event: RealtimeEvent): Promise<void> {
  const sender = event.author?.trim() || 'Менеджер'
  const channel = channelLabel(event.channelType)
  const body = event.body ? truncate(event.body) : 'Новый ответ'

  void sendPushToGod({
    title: `${sender} · ${channel}`,
    body,
    url: event.conversationId
      ? `/wijegniwjgwjog/messages?c=${event.conversationId}`
      : '/wijegniwjgwjog/messages',
    tag: event.conversationId
      ? `god:${event.conversationId}`
      : 'god:messages',
  }).catch(() => {
    /* delivery failures are handled/logged inside sendPushToGod */
  })
}

async function handleEvent(event: RealtimeEvent): Promise<void> {
  if (event.type !== 'message') return
  // Only brand-new messages notify. Message UPDATE events (status→read,
  // reactions, soft-delete) reuse type:'message' + direction, so without this
  // guard every status change would fire a duplicate push. Legacy events with
  // no `event` field are treated as inserts for back-compat.
  if (event.event && event.event !== 'insert') return

  // Outbound reply → push the website visitor (live-chat) AND the god messenger
  // (any manager reply, any channel — the god "is" the client there).
  if (event.direction === 'out') {
    await handleGodReply(event)
    await handleVisitorReply(event)
    return
  }

  // Only brand-new inbound messages should notify managers.
  if (event.direction !== 'in') return
  if (!event.managerId) return

  // Respect per-conversation mute: silenced contacts never push.
  if (event.conversationId) {
    try {
      if (await isConversationMuted(event.conversationId)) return
    } catch {
      /* on lookup failure, fall through and notify rather than drop silently */
    }
  }

  const sender =
    event.contactName?.trim() ||
    event.contactHandle?.trim() ||
    'Новое сообщение'
  const channel = channelLabel(event.channelType)
  const title = `${sender} · ${channel}`
  const body = event.body ? truncate(event.body) : 'Новое сообщение'

  void sendPushToManager(event.managerId, {
    title,
    body,
    url: '/app/inbox',
    // Collapse repeated messages from the same conversation into one bubble.
    tag: event.conversationId
      ? `conv:${event.conversationId}`
      : `mgr:${event.managerId}`,
  }).catch(() => {
    /* delivery failures are handled/logged inside sendPushToManager */
  })
}

/** Idempotently start the dispatcher. Safe to call multiple times. */
export function startPushDispatcher(): void {
  if (globalForDispatcher.__pushDispatcherStarted) return
  if (!isPushConfigured()) {
    // No VAPID keys — nothing to dispatch. This is THE most common reason
    // pushes "silently stop" after a server move/redeploy, so say it loudly
    // in the boot log instead of failing invisibly: without the warning the
    // only symptom is managers not getting pushes, with no error anywhere.
    console.warn(
      '[push] Dispatcher NOT started: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are missing. ' +
        'Web Push to managers is disabled. Generate keys with ' +
        `node -e "console.log(require('web-push').generateVAPIDKeys())" ` +
        'and set them in the environment, then restart the panel.',
    )
    return
  }
  globalForDispatcher.__pushDispatcherStarted = true
  subscribeRealtime((event) => {
    void handleEvent(event).catch(() => {
      /* never let a notification error crash the realtime hub */
    })
  })
  console.log(
    '[push] Dispatcher started: VAPID configured, listening for inbound messages.',
  )
}
