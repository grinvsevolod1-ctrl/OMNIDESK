import { randomInt } from 'node:crypto'
import { OP, PUSH_OP, type MaxPacket } from './protocol.js'
import type { MaxClient } from './client.js'

/**
 * Message-level operations over a connected+authenticated MaxClient, plus
 * parsing of server push packets into a normalized shape the session can hand
 * to the shared inbox repo. Kept separate from the transport so the wire
 * details (payload field names) are all in one place — the most likely thing
 * to drift if MAX changes its protocol.
 */

/** A normalized inbound message extracted from a MAX push packet. */
export interface MaxInboundMessage {
  chatId: string
  messageId: string
  senderId: string | null
  text: string
  /** ms epoch; falls back to now() when the packet omits it. */
  timestamp: number
  /** True when the message was sent BY the logged-in account (echo). */
  outgoing: boolean
}

/** Generate the client-side message id MAX expects (cid): a random int. */
function newCid(): number {
  return randomInt(1, 2_000_000_000)
}

/** Send a text message to a chat. Returns the server packet. */
export async function sendText(
  client: MaxClient,
  chatId: string,
  text: string,
): Promise<MaxPacket> {
  return client.invoke(OP.SEND_MESSAGE, {
    chatId: Number(chatId),
    message: {
      text,
      cid: newCid(),
      elements: [],
      attaches: [],
    },
    notify: true,
  })
}

/** Reply to a specific message within a chat. */
export async function replyText(
  client: MaxClient,
  chatId: string,
  text: string,
  replyToMessageId: string,
): Promise<MaxPacket> {
  return client.invoke(OP.SEND_MESSAGE, {
    chatId: Number(chatId),
    message: {
      text,
      cid: newCid(),
      elements: [],
      attaches: [],
      link: { type: 'REPLY', messageId: replyToMessageId },
    },
    notify: true,
  })
}

/** Edit a previously sent message. */
export async function editText(
  client: MaxClient,
  chatId: string,
  messageId: string,
  text: string,
): Promise<MaxPacket> {
  return client.invoke(OP.EDIT_MESSAGE, {
    chatId: Number(chatId),
    messageId,
    text,
    elements: [],
    attaches: [],
  })
}

/** Delete a message (for everyone when supported). */
export async function deleteMessage(
  client: MaxClient,
  chatId: string,
  messageId: string,
): Promise<MaxPacket> {
  return client.invoke(OP.DELETE_MESSAGE, {
    chatId: Number(chatId),
    messageIds: [messageId],
    forMe: false,
  })
}

/** Mark a chat read up to a message. */
export async function markRead(
  client: MaxClient,
  chatId: string,
  messageId: string,
): Promise<MaxPacket> {
  return client.invoke(OP.READ, {
    type: 'READ_MESSAGE',
    chatId: Number(chatId),
    messageId,
    mark: Date.now(),
  })
}

/** Send a typing indicator to a chat. */
export async function sendTyping(
  client: MaxClient,
  chatId: string,
): Promise<MaxPacket> {
  return client.invoke(OP.TYPING, {
    chatId: Number(chatId),
    action: 'TYPING',
  })
}

/** Add a reaction (emoji) to a message. */
export async function react(
  client: MaxClient,
  chatId: string,
  messageId: string,
  emoji: string,
): Promise<MaxPacket> {
  return client.invoke(OP.REACT, {
    chatId: Number(chatId),
    messageId,
    reaction: { reactionType: 'EMOJI', id: emoji },
  })
}

/** Fetch the initial chat list / recent history. */
export async function fetchChats(
  client: MaxClient,
  count = 40,
): Promise<MaxPacket> {
  return client.invoke(OP.FETCH_CHATS, {
    chatsCount: count,
    chatsSync: 0,
    marker: 0,
  })
}

/**
 * Parse a server push packet into a normalized inbound message, or null if the
 * packet isn't a new user message (edits, receipts, typing, media acks, etc.
 * are handled elsewhere or ignored). `selfId` lets us flag our own echoes as
 * outgoing so they aren't treated as customer replies.
 */
export function parseInbound(
  packet: MaxPacket,
  selfId: string | null,
): MaxInboundMessage | null {
  if (packet.opcode !== PUSH_OP.NEW_MESSAGE) return null

  const payload = packet.payload as {
    chatId?: number | string
    message?: {
      id?: string
      sender?: number | string
      text?: string
      time?: number
    }
  }
  const msg = payload.message
  if (!msg || !payload.chatId) return null
  // Text-only in the first version; media/stickers are a later milestone.
  const text = typeof msg.text === 'string' ? msg.text : ''
  if (!text) return null

  const senderId = msg.sender != null ? String(msg.sender) : null
  return {
    chatId: String(payload.chatId),
    messageId: msg.id ? String(msg.id) : `${payload.chatId}:${msg.time ?? Date.now()}`,
    senderId,
    text,
    timestamp: typeof msg.time === 'number' ? msg.time : Date.now(),
    outgoing: selfId != null && senderId === selfId,
  }
}
