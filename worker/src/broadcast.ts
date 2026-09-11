import { TelegramClient, Api } from 'teleproto'
import { logger } from './logger.js'
import { errMessage } from './telegram-errors.js'

/**
 * MTProto primitives for the group broadcast feature, on a PERSONAL session
 * (worker/src/personal.ts). Each function is best-effort and classifies its
 * failure so the runner can decide retry vs. skip vs. "needs a human".
 *
 * Flow per group (see broadcast-runner.ts):
 *   1. parseTarget  — link/@username → { kind, key }
 *   2. joinTarget   — public join or invite-hash import; returns the entity
 *   3. passCaptcha  — many подработок-groups run a "ты не бот?" gate bot;
 *      answer it (click an inline button whose text looks like consent, else
 *      reply with the configured phrase) — BEFORE and AFTER posting
 *   4. postToGroup  — send the per-group text variant
 *
 * We NEVER persist group members or their messages (privacy invariant); the
 * only thing read from a group is the last few messages, transiently, to detect
 * the gate bot.
 */

export type TargetKind = 'public' | 'invite'

export interface ParsedTarget {
  kind: TargetKind
  /** public → @username (no @); invite → the invite hash after the +/joinchat. */
  key: string
}

/** Classify how the account can reach the raw input. Throws on garbage. */
export function parseTarget(raw: string): ParsedTarget {
  let s = raw.trim()
  if (!s) throw new Error('EMPTY_TARGET')

  // Strip protocol and host so t.me/foo, https://t.me/foo, @foo, foo all work.
  s = s.replace(/^https?:\/\//i, '').replace(/^t\.me\//i, '').replace(/^telegram\.me\//i, '')

  // Invite links: t.me/+HASH or t.me/joinchat/HASH.
  if (s.startsWith('+')) return { kind: 'invite', key: s.slice(1) }
  if (/^joinchat\//i.test(s)) return { kind: 'invite', key: s.replace(/^joinchat\//i, '') }

  // Public: @username or username, drop any trailing path/query.
  s = s.replace(/^@/, '').split(/[/?#]/)[0]
  if (!/^[a-zA-Z][a-zA-Z0-9_]{3,}$/.test(s)) throw new Error('BAD_TARGET_FORMAT')
  return { kind: 'public', key: s }
}

export interface JoinResult {
  entity: Api.TypeInputPeer | string
  /** Resolved public id and title for the panel preview. */
  peerId: string
  title: string
  /** True when we were already a member (idempotent re-run). */
  alreadyMember: boolean
}

/**
 * Join the group. Public groups → channels.JoinChannel; invite links →
 * messages.ImportChatInvite (falls back to CheckChatInvite when already a
 * member or when the join needs admin approval). Returns the entity to post to.
 */
export async function joinTarget(
  client: TelegramClient,
  target: ParsedTarget,
): Promise<JoinResult> {
  if (target.kind === 'public') {
    const entity = await client.getEntity(target.key)
    try {
      await client.invoke(
        new Api.channels.JoinChannel({ channel: target.key }),
      )
    } catch (err) {
      const msg = errMessage(err)
      // Already a participant is success, not failure.
      if (!/ALREADY_PARTICIPANT|USER_ALREADY_PARTICIPANT/i.test(msg)) {
        // Non-membership errors (private, banned, invalid) bubble up.
        if (/INVITE_REQUEST_SENT/i.test(msg)) {
          throw new Error('NEEDS_APPROVAL')
        }
        throw err
      }
    }
    return describeEntity(entity, true)
  }

  // Invite hash.
  try {
    const updates = await client.invoke(
      new Api.messages.ImportChatInvite({ hash: target.key }),
    )
    const chat = extractChatFromUpdates(updates)
    if (chat) return describeEntity(chat, false)
  } catch (err) {
    const msg = errMessage(err)
    if (/USER_ALREADY_PARTICIPANT/i.test(msg)) {
      // Resolve via CheckChatInvite to get the chat we're already in.
      const checked = await client.invoke(
        new Api.messages.CheckChatInvite({ hash: target.key }),
      )
      const chat = (checked as { chat?: Api.TypeChat }).chat
      if (chat) return describeEntity(chat, true)
    }
    if (/INVITE_REQUEST_SENT/i.test(msg)) throw new Error('NEEDS_APPROVAL')
    throw err
  }
  throw new Error('JOIN_NO_CHAT')
}

/** Post one text message to a joined group. Returns provider message id. */
export async function postToGroup(
  client: TelegramClient,
  entity: Api.TypeInputPeer | string,
  text: string,
): Promise<string | null> {
  const sent = await client.sendMessage(entity, { message: text })
  return sent?.id != null ? String(sent.id) : null
}

/** Words that, in a gate-bot prompt or button, signal the "I'm human" action. */
const CONSENT_HINTS = [
  'не бот',
  'не робот',
  'человек',
  'согласен',
  'ознакомлен',
  'принима',
  'правила',
  'подтвер',
  'i am not a bot',
  "i'm not a bot",
  'not a robot',
  'agree',
  'accept',
]

/** Does this text look like a "ты не бот?" gate prompt from a bot? */
function looksLikeGatePrompt(text: string): boolean {
  const t = text.toLowerCase()
  if (!t) return false
  return (
    /бот|robot|капч|captcha|подтверд|verify|verification/i.test(t) &&
    /\?|нажми|кнопк|button|tap|click|press|ответь|reply/i.test(t)
  )
}

export type CaptchaOutcome = 'passed' | 'none' | 'needs_human'

/**
 * Best-effort gate-bot handling. Reads the last few messages; if a bot posted a
 * gate prompt addressed to newcomers, either click the consent inline button or
 * reply with the configured phrase. Returns:
 *   - 'passed'      we took a plausible human action
 *   - 'none'        no gate prompt detected (nothing to do)
 *   - 'needs_human' a gate exists but needs a real person (image captcha, etc.)
 *
 * NEVER throws — captcha handling failures degrade to 'needs_human'.
 */
export async function passCaptcha(
  client: TelegramClient,
  entity: Api.TypeInputPeer | string,
  replyPhrase: string,
): Promise<CaptchaOutcome> {
  let messages: Api.Message[]
  try {
    messages = await client.getMessages(entity, { limit: 8 })
  } catch (err) {
    logger.warn({ err: errMessage(err) }, 'broadcast: captcha read failed')
    return 'none'
  }

  for (const msg of messages) {
    const text = msg.message ?? ''
    const fromBot = isFromBot(msg)
    if (!fromBot && !looksLikeGatePrompt(text)) continue
    if (!looksLikeGatePrompt(text) && !hasConsentButton(msg)) continue

    // 1. Prefer clicking a consent inline button — the intended UX.
    const clicked = await tryClickConsentButton(client, entity, msg)
    if (clicked) return 'passed'

    // 2. Otherwise reply with the configured phrase in the group.
    if (looksLikeGatePrompt(text)) {
      try {
        await client.sendMessage(entity, {
          message: replyPhrase,
          replyTo: msg.id,
        })
        return 'passed'
      } catch (err) {
        logger.warn({ err: errMessage(err) }, 'broadcast: captcha reply failed')
        return 'needs_human'
      }
    }

    // A gate prompt we recognized but couldn't action (e.g. image captcha).
    return 'needs_human'
  }
  return 'none'
}

/* ------------------------------- Internals -------------------------------- */

function isFromBot(msg: Api.Message): boolean {
  const sender = msg.sender as { bot?: boolean } | undefined
  if (sender?.bot) return true
  // viaBotId set → message came through a bot.
  return (msg as { viaBotId?: unknown }).viaBotId != null
}

function hasConsentButton(msg: Api.Message): boolean {
  const markup = msg.replyMarkup as Api.ReplyInlineMarkup | undefined
  if (!markup || !('rows' in markup)) return false
  for (const row of markup.rows) {
    for (const btn of row.buttons) {
      const label = (btn as { text?: string }).text?.toLowerCase() ?? ''
      if (CONSENT_HINTS.some((h) => label.includes(h))) return true
    }
  }
  return false
}

/**
 * Click the first inline button whose label looks like consent. Handles plain
 * callback buttons (GetBotCallbackAnswer). URL/login buttons can't be clicked
 * headlessly → returns false so the caller falls back or flags needs_human.
 */
async function tryClickConsentButton(
  client: TelegramClient,
  entity: Api.TypeInputPeer | string,
  msg: Api.Message,
): Promise<boolean> {
  const markup = msg.replyMarkup as Api.ReplyInlineMarkup | undefined
  if (!markup || !('rows' in markup)) return false

  for (const row of markup.rows) {
    for (const btn of row.buttons) {
      const label = (btn as { text?: string }).text?.toLowerCase() ?? ''
      if (!CONSENT_HINTS.some((h) => label.includes(h))) continue

      // Only callback buttons carry `data` we can submit headlessly.
      const data = (btn as { data?: Buffer }).data
      if (!data) return false
      try {
        await client.invoke(
          new Api.messages.GetBotCallbackAnswer({
            peer: entity,
            msgId: msg.id,
            data,
          }),
        )
        return true
      } catch (err) {
        logger.warn(
          { err: errMessage(err) },
          'broadcast: callback answer failed',
        )
        return false
      }
    }
  }
  return false
}

function describeEntity(
  entity: Api.TypeChat | Api.TypeUser | Api.TypeInputPeer | string,
  alreadyMember: boolean,
): JoinResult {
  const anyEntity = entity as {
    id?: unknown
    title?: string
    username?: string
  }
  const peerId = anyEntity.id != null ? String(anyEntity.id) : ''
  const title = anyEntity.title || anyEntity.username || peerId || 'Группа'
  return { entity: entity as Api.TypeInputPeer | string, peerId, title, alreadyMember }
}

/**
 * Pull the joined chat out of whatever ImportChatInvite returned. Different
 * teleproto responses (Updates, ChatInviteJoinResult) both carry a `chats`
 * array, so we read it structurally rather than by exact union member.
 */
function extractChatFromUpdates(result: unknown): Api.TypeChat | null {
  const chats = (result as { chats?: Api.TypeChat[] }).chats
  return chats && chats.length > 0 ? chats[0] : null
}
