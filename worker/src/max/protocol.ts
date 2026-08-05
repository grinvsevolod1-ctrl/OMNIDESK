/**
 * MAX (OneMe) unofficial WebSocket protocol constants.
 *
 * ⚠️ This is a REVERSE-ENGINEERED protocol. MAX has no official account API;
 * everything here mirrors what the MAX web client (web.max.ru) sends over
 * wss://ws-api.oneme.ru/websocket, cross-checked against the `vkmax` reference
 * library (github.com/nsdkinx/vkmax). It can change without notice.
 *
 * EVERY protocol-version-sensitive constant lives in this ONE file on purpose:
 * when MAX bumps its web client, updating RPC_VERSION / APP_VERSION / a changed
 * opcode here is the entire fix. The canary check (max/canary.ts) watches the
 * handshake so we find out the moment these drift.
 */

export const WS_HOST = 'wss://ws-api.oneme.ru/websocket'
export const WS_ORIGIN = 'https://web.max.ru'

/** Protocol envelope version. Bump when the web client does. */
export const RPC_VERSION = 11
/** MAX web app version advertised in the hello packet. */
export const APP_VERSION = '26.2.2'
export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/**
 * Opcodes. Names are ours (the wire only carries numbers); values are the
 * protocol's. Grouped by direction/purpose. Sourced from vkmax opcodes.md +
 * client.py and confirmed against live web-client traffic shapes.
 */
export const OP = {
  /** Keepalive ping (payload {interactive:false}); also generic heartbeat. */
  PING: 1,
  /** Hello / handshake: advertises userAgent + deviceId. */
  HELLO: 6,
  /** START_AUTH: request an SMS code for a phone; returns a login token. */
  START_AUTH: 17,
  /** CHECK_CODE: submit the SMS code + token; returns the session profile. */
  CHECK_CODE: 18,
  /** Login by saved session token (reconnect without SMS). */
  LOGIN_BY_TOKEN: 19,
  /** Fetch chats / history. */
  FETCH_CHATS: 50,
  /** Send a message. */
  SEND_MESSAGE: 64,
  /** Edit a message. */
  EDIT_MESSAGE: 65,
  /** Mark messages read. */
  READ: 66,
  /** Typing / activity indicator. */
  TYPING: 67,
  /** Delete a message. */
  DELETE_MESSAGE: 68,
  /** Add / remove a reaction. */
  REACT: 178,
  /** Media upload ack (server -> client). */
  MEDIA_ACK: 136,
} as const

/**
 * Server-initiated opcodes that arrive WITHOUT a matching request seq — these
 * are pushes (new message, edit, read receipt, typing) the recv loop routes to
 * the event callback rather than a pending future.
 */
export const PUSH_OP = {
  /** A new message (incoming or echoed outgoing). */
  NEW_MESSAGE: 128,
  /** A message was edited. */
  MESSAGE_EDITED: 129,
  /** A message was deleted. */
  MESSAGE_DELETED: 130,
  /** Read receipt / chat marker moved. */
  READ_RECEIPT: 131,
  /** Peer typing. */
  TYPING: 132,
} as const

/** RPC envelope sent to the server. `cmd:0` = request. */
export interface MaxRequest {
  ver: number
  cmd: 0
  seq: number
  opcode: number
  payload: Record<string, unknown>
}

/** Any packet received from the server. */
export interface MaxPacket {
  ver?: number
  cmd?: number
  seq: number
  opcode?: number
  payload: Record<string, unknown>
}

/** The hello/userAgent block. Values mirror a MAX web session. */
export function helloUserAgent() {
  return {
    deviceType: 'WEB',
    locale: 'ru',
    deviceLocale: 'ru',
    osVersion: 'Linux',
    deviceName: 'Chrome',
    headerUserAgent: USER_AGENT,
    appVersion: APP_VERSION,
    screen: '1080x1920 1.0x',
    timezone: 'Europe/Moscow',
  }
}
