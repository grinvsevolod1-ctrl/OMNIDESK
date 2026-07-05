import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON,
  downloadMediaMessage,
  proto,
  type AuthenticationState,
  type WASocket,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import { logger } from './logger.js'
import { waAgent } from './proxy.js'
import * as repo from './repo.js'
import { onInbound as onAutopilotInbound } from './autopilot.js'

interface StoredState {
  creds: ReturnType<typeof initAuthCreds>
  keys: Record<string, Record<string, unknown>>
}

/**
 * Hard cap on how long an UNLINKED session may stay in starting / qr_pending /
 * code_pending before we give up. Without this the socket (and the panel
 * spinner) can wait forever when the QR/pairing code is never scanned, the
 * proxy is dead, or WhatsApp never reaches `open`. When it fires the channel is
 * moved to `error`, giving the UI a terminal state to stop the loader on.
 */
const LINK_TIMEOUT_MS = 120_000

/* --------------------------- Anti-ban tuning --------------------------- */
// Reconnects use exponential backoff with jitter instead of a fixed fast loop.
// A tight reconnect loop is the #1 self-inflicted ban vector: it looks like an
// abusive client to WhatsApp and gets the account flagged/blocked.
const RECONNECT_BASE_MS = 5_000 // first retry delay
const RECONNECT_MAX_MS = 5 * 60_000 // cap between retries (5 min)
const RECONNECT_MAX_ATTEMPTS = 8 // after this we stop and cool down
// `restartRequired` (515) is a normal protocol request to re-open the socket
// right after linking — not a failure. Restart almost immediately (tiny delay
// just to let the old socket fully close) instead of using backoff.
const RESTART_REQUIRED_DELAY_MS = 750

// Outgoing-message throttle: WhatsApp flags accounts that fire messages with
// machine-like speed. We enforce a minimum spacing plus a small random human
// jitter between sends on the SAME account.
const SEND_MIN_INTERVAL_MS = 1_200
const SEND_JITTER_MS = 800

/**
 * How long a send waits for WhatsApp's server ack (SERVER_ACK, status >= 2)
 * before it's treated as failed. `sock.sendMessage()` resolves the moment the
 * frame is queued on the socket — it does NOT prove WhatsApp accepted it. Behind
 * a flaky proxy the WebSocket can be half-dead, so the message would otherwise
 * be reported "sent" yet never leave. Waiting for the ack is what makes a send
 * truthful.
 */
const SEND_ACK_TIMEOUT_MS = 20_000

/**
 * If a send isn't acked AND we've had no inbound traffic from WhatsApp for at
 * least this long, the socket is presumed dead and we force a reconnect. When
 * traffic is recent the socket is fine and the message was rejected at the
 * account/contact level (e.g. error 463 reach-out restriction) — reconnecting
 * wouldn't help and would just churn the connection, so we only mark it failed.
 */
const SOCKET_STALE_MS = 40_000

/**
 * How long a send will wait for a reconnecting socket to reach 'open' before
 * giving up. Keeps a send issued during a brief blip from failing instantly,
 * without hanging forever when the session is really down.
 */
const SEND_WAIT_OPEN_MS = 12_000

/* ----------------------- Connection hardening ----------------------- */
// Lower keep-alive so a silently dropped (proxy-killed) WebSocket is detected in
// well under a minute and triggers our reconnect, instead of lingering as a
// half-open socket that accepts sends into the void.
const KEEPALIVE_INTERVAL_MS = 20_000
// Bound the initial connect so a dead proxy fails fast into backoff.
const CONNECT_TIMEOUT_MS = 45_000
// Small delay before Baileys retries a failed decryption/request.
const RETRY_REQUEST_DELAY_MS = 1_000

/**
 * How long to wait for the WebSocket close frame to flush when stopping a
 * session. Tearing the socket down WITHOUT waiting (the old `sock.end()` then
 * immediately drop) means that on a worker restart the next process can
 * reconnect the SAME WhatsApp device while the previous socket is still
 * half-open. WhatsApp's multi-device protocol treats two live connections for
 * one device as a conflict and force-invalidates the session with a 401
 * loggedOut — which is exactly the "requires re-login" incident we diagnosed.
 * Waiting for a clean close (bounded by this timeout) lets WhatsApp register
 * the disconnect before any reconnect happens.
 */
const SOCKET_CLOSE_GRACE_MS = 4_000

/**
 * Close a Baileys socket and resolve once the underlying WebSocket has actually
 * emitted `close` (or the grace timeout elapses, whichever comes first). Never
 * rejects — teardown must always make progress.
 */
function closeSocketGracefully(
  sock: WASocket,
  timeoutMs = SOCKET_CLOSE_GRACE_MS,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    try {
      const ws = (sock as unknown as { ws?: { on?: (e: string, cb: () => void) => void } }).ws
      ws?.on?.('close', finish)
      sock.end(undefined)
    } catch {
      finish()
    }
  })
}

/**
 * Module-level cache of the current WhatsApp Web version. Without this, EVERY
 * reconnect would hit fetchLatestBaileysVersion() over the network — wasteful
 * and, under a reconnect storm, another way to look abusive. Cached for 6h.
 */
let waVersionCache: { version: [number, number, number]; at: number } | null =
  null
const WA_VERSION_TTL_MS = 6 * 60 * 60_000

async function getWaWebVersion(
  channelId: string,
): Promise<[number, number, number] | undefined> {
  if (waVersionCache && Date.now() - waVersionCache.at < WA_VERSION_TTL_MS) {
    return waVersionCache.version
  }
  try {
    const res = await fetchLatestBaileysVersion()
    waVersionCache = { version: res.version, at: Date.now() }
    logger.info(
      { channelId, version: res.version, isLatest: res.isLatest },
      'WhatsApp using WA Web version',
    )
    return res.version
  } catch (err) {
    logger.warn(
      { err, channelId },
      'Could not fetch latest WA Web version, using bundled default',
    )
    return waVersionCache?.version
  }
}

/**
 * Disconnect status codes that mean "do NOT keep reconnecting": the account is
 * gone, replaced, or being actively rejected by WhatsApp. Hammering through
 * these is exactly what escalates a temporary restriction into a permanent ban.
 */
function isFatalDisconnect(code: number | undefined): boolean {
  if (code == null) return false
  return (
    code === DisconnectReason.loggedOut || // 401: unlinked
    code === DisconnectReason.forbidden || // 403: account blocked/forbidden
    code === DisconnectReason.badSession || // corrupt creds — relink needed
    code === DisconnectReason.connectionReplaced // 440: opened elsewhere
  )
}

/**
 * Turn a WhatsApp message payload into a human-readable preview string.
 *
 * Plain text and captioned media return their text; non-text media return a
 * compact bracketed placeholder (the panel only stores text, so we surface the
 * KIND of attachment instead of a useless "[non-text message]"). Returns null
 * for payloads that carry nothing displayable (reactions, receipts, protocol
 * messages) so the caller can skip them.
 */
function describeWaMessage(
  message: proto.IMessage | null | undefined,
): string | null {
  if (!message) return null
  if (message.conversation) return message.conversation
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text

  const withCaption = (caption: string | null | undefined, label: string) =>
    caption ? `${label} ${caption}` : label

  if (message.imageMessage)
    return withCaption(message.imageMessage.caption, '[image]')
  if (message.videoMessage)
    return withCaption(message.videoMessage.caption, '[video]')
  if (message.documentMessage)
    return withCaption(
      message.documentMessage.caption,
      `[document${message.documentMessage.fileName ? `: ${message.documentMessage.fileName}` : ''}]`,
    )
  if (message.audioMessage)
    return message.audioMessage.ptt ? '[voice message]' : '[audio]'
  if (message.stickerMessage) return '[sticker]'
  if (message.locationMessage) return '[location]'
  if (message.liveLocationMessage) return '[live location]'
  if (message.contactMessage || message.contactsArrayMessage) return '[contact]'
  if (message.pollCreationMessage || message.pollCreationMessageV3)
    return '[poll]'
  if (message.reactionMessage) return null // not a thread message
  return '[message]'
}

/**
 * Map a WhatsApp message ack level to our delivery status. The proto enum is
 * ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5. Anything
 * below SERVER_ACK isn't a meaningful forward step, so we ignore it.
 */
function mapWaStatus(status: number): repo.MessageStatus | null {
  if (status >= 4) return 'read' // READ or PLAYED
  if (status === 3) return 'delivered' // DELIVERY_ACK
  if (status === 2) return 'sent' // SERVER_ACK
  return null
}

/** Recognised media kinds extracted from a WhatsApp message. */
interface WaMediaInfo {
  mediaType: 'image' | 'video' | 'video_note' | 'audio' | 'voice' | 'sticker' | 'document'
  mediaMime: string | null
  mediaName: string | null
}

/**
 * Classify the downloadable media carried by a WhatsApp message. Returns null
 * for text-only / non-media messages (location, contact, poll, …) which we can
 * still show as text but cannot stream.
 */
function classifyWaMedia(
  message: proto.IMessage | null | undefined,
): WaMediaInfo | null {
  if (!message) return null
  if (message.imageMessage) {
    return {
      mediaType: 'image',
      mediaMime: message.imageMessage.mimetype || 'image/jpeg',
      mediaName: null,
    }
  }
  if (message.videoMessage) {
    // gifPlayback videos are short looping clips; still a 'video' for playback.
    return {
      mediaType: 'video',
      mediaMime: message.videoMessage.mimetype || 'video/mp4',
      mediaName: null,
    }
  }
  if (message.audioMessage) {
    return {
      mediaType: message.audioMessage.ptt ? 'voice' : 'audio',
      mediaMime: message.audioMessage.mimetype || 'audio/ogg',
      mediaName: null,
    }
  }
  if (message.stickerMessage) {
    return {
      mediaType: 'sticker',
      mediaMime: message.stickerMessage.mimetype || 'image/webp',
      mediaName: null,
    }
  }
  if (message.documentMessage) {
    return {
      mediaType: 'document',
      mediaMime: message.documentMessage.mimetype || null,
      mediaName: message.documentMessage.fileName || null,
    }
  }
  return null
}

/**
 * One live WhatsApp Web (Baileys) session bound to a channel. Auth state is
 * persisted to the DB (encrypted) as a single BufferJSON blob, so the session
 * survives worker restarts without re-scanning the QR.
 */
export class WhatsAppSession {
  readonly channelId: string
  readonly managerId: string
  private sock: WASocket | null = null
  private state: StoredState | null = null
  /** Latest QR as a data-URL, exposed to the panel while qr_pending. */
  qrDataUrl: string | null = null
  /** 8-char pairing code, exposed to the panel for non-SMS phone linking. */
  pairingCode: string | null = null
  private stopping = false
  /**
   * Soft pause. When true the socket stays connected (account alive) but inbound
   * messages and history are NOT written to the inbox. Set via pause/resume jobs
   * and restored from the channel record on (re)start so it survives restarts.
   */
  private ingestPaused = false
  /** Digits-only phone for pairing-code login (no +, spaces or symbols). */
  private pairPhone: string | null = null
  private pairingRequested = false
  /** Fires once if linking never reaches `open` in time; moves to `error`. */
  private linkTimer: ReturnType<typeof setTimeout> | null = null
  /** Last raw QR string, so we don't re-encode/re-write identical QRs. */
  private lastQr: string | null = null
  /** Consecutive failed reconnects; drives exponential backoff. Reset on open. */
  private reconnectAttempts = 0
  /** Pending backoff timer, so stop()/logout() can cancel a queued reconnect. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** Timestamp of the last outgoing send, for per-account rate limiting. */
  private lastSentAt = 0
  /**
   * Timestamp of the last inbound traffic from WhatsApp (any message event or a
   * successful open). Used to tell a genuinely dead socket from a healthy socket
   * that merely rejected one message: we only force a reconnect when the socket
   * itself looks stale, never just because a single send wasn't acked.
   */
  private lastRecvAt = Date.now()
  /**
   * Live connection state mirrored from `connection.update`. Sends are only
   * attempted when this is 'open'; otherwise a "sent" would silently rot in the
   * socket's buffer behind a half-dead proxy connection.
   */
  private connectionState: 'connecting' | 'open' | 'close' = 'connecting'
  /**
   * Waiters parked until the socket reaches 'open' (used by sends that arrive
   * during a brief reconnect). Resolved with true on open, false on give-up.
   */
  private openWaiters: Array<(ok: boolean) => void> = []
  /**
   * Pending server-ack waiters keyed by provider message id. A send is only
   * considered truly delivered to WhatsApp's servers once it gets SERVER_ACK
   * (status >= 2); these resolve from the messages.update / upsert handlers.
   */
  private pendingAcks = new Map<string, (ok: boolean) => void>()
  /**
   * In-flight start() promise. Concurrent start/restart/request_qr jobs for the
   * same channel (a NOTIFY storm, or drainQueue racing restore on deploy) must
   * NOT each open their own socket — two live connections for one device is the
   * multi-device conflict that triggers a 401 logout. All callers share this
   * single promise instead.
   */
  private startInFlight: Promise<{ sessionStatus: repo.SessionStatus }> | null =
    null

  constructor(channelId: string, managerId: string) {
    this.channelId = channelId
    this.managerId = managerId
  }

  /**
   * Toggle the soft pause. Only affects inbound persistence — the live socket is
   * deliberately left running so the WhatsApp account stays linked and healthy.
   */
  setIngestPaused(paused: boolean): void {
    this.ingestPaused = paused
  }

  /**
   * Arm the linking timeout (idempotent). Only used while the device is not yet
   * registered — an already-linked session that briefly drops should be allowed
   * to reconnect without being flipped to `error`.
   */
  private armLinkTimeout(): void {
    if (this.linkTimer) return
    this.linkTimer = setTimeout(async () => {
      this.linkTimer = null
      if (this.stopping) return
      this.stopping = true
      this.pairingCode = null
      this.qrDataUrl = null
      this.lastQr = null
      try {
        this.sock?.end(undefined)
      } catch {
        /* ignore */
      }
      this.sock = null
      await repo
        .setSession(this.channelId, 'error', {
          lastError:
            'Linking timed out. Start again and enter the pairing code (or scan the QR) right away.',
        })
        .catch(() => {})
      logger.warn({ channelId: this.channelId }, 'WhatsApp linking timed out')
    }, LINK_TIMEOUT_MS)
  }

  private clearLinkTimeout(): void {
    if (this.linkTimer) {
      clearTimeout(this.linkTimer)
      this.linkTimer = null
    }
  }

  /** Cancel any queued reconnect (used by stop/logout/fatal paths). */
  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /* ---------------------- send liveness helpers ---------------------- */

  /** Resolve every parked open-waiter with the given outcome, then clear them. */
  private flushOpenWaiters(ok: boolean): void {
    const waiters = this.openWaiters
    this.openWaiters = []
    for (const w of waiters) w(ok)
  }

  /** Fail every outstanding ack-waiter (socket closed before acks arrived). */
  private failPendingAcks(): void {
    const acks = [...this.pendingAcks.values()]
    this.pendingAcks.clear()
    for (const a of acks) a(false)
  }

  /** Resolve the ack-waiter for a provider message id, if one is pending. */
  private resolveAck(id: string, ok: boolean): void {
    const waiter = this.pendingAcks.get(id)
    if (waiter) {
      this.pendingAcks.delete(id)
      waiter(ok)
    }
  }

  /**
   * Resolve true once the socket is 'open'. If it's mid-reconnect, park until the
   * next 'open' (or until it gives up / the wait times out). Resolves false when
   * there's no socket or the wait elapses, so the caller can fail the send
   * instead of writing into a dead connection.
   */
  private waitForOpen(timeoutMs: number): Promise<boolean> {
    if (this.connectionState === 'open' && this.sock) return Promise.resolve(true)
    if (!this.sock || this.stopping) return Promise.resolve(false)
    return new Promise((resolve) => {
      let settled = false
      const done = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(ok)
      }
      const timer = setTimeout(() => done(false), timeoutMs)
      this.openWaiters.push(done)
    })
  }

  /**
   * Wait for WhatsApp's server ack for a just-sent message id. Resolves true on
   * SERVER_ACK (status >= 2), false on timeout or socket close. This is what
   * turns "queued on the socket" into "actually accepted by WhatsApp".
   */
  private waitForAck(id: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const done = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pendingAcks.delete(id)
        resolve(ok)
      }
      const timer = setTimeout(() => done(false), timeoutMs)
      this.pendingAcks.set(id, done)
    })
  }

  /**
   * Schedule a reconnect using exponential backoff with jitter. After
   * RECONNECT_MAX_ATTEMPTS we give up and move to `rate_limited`, deliberately
   * cooling down instead of hammering WhatsApp (which risks a ban). The delay
   * grows 5s → 10s → 20s … capped at 5 min, plus random jitter so multiple
   * accounts never reconnect in a synchronized burst.
   */
  private scheduleReconnect(code: number | undefined): void {
    this.clearReconnect()
    this.reconnectAttempts += 1

    if (this.reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
      this.stopping = true
      void repo.setSession(this.channelId, 'rate_limited', {
        lastError:
          'Repeated reconnect failures — paused to protect the account from being flagged. Reconnect manually to try again.',
      })
      logger.error(
        { channelId: this.channelId, attempts: this.reconnectAttempts, code },
        'WhatsApp reconnect attempts exhausted, cooling down',
      )
      return
    }

    const backoff = Math.min(
      RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1),
      RECONNECT_MAX_MS,
    )
    const delay = backoff + Math.floor(Math.random() * RECONNECT_BASE_MS)
    void repo.setSession(this.channelId, 'offline')
    logger.warn(
      { channelId: this.channelId, code, attempt: this.reconnectAttempts, delay },
      'WhatsApp disconnected, scheduling backoff reconnect',
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopping) return
      this.start({ _isRetry: true }).catch(() => {})
    }, delay)
  }

  /**
   * Handle a `restartRequired` (515) close. This is NOT a failure: right after
   * linking — and occasionally on a normal reconnect — WhatsApp asks the client
   * to drop and immediately re-open the socket with the negotiated session. The
   * correct response is a fast restart, NOT exponential backoff. Routing 515
   * through scheduleReconnect was making linking slow and could burn the retry
   * budget (→ false `rate_limited`). We restart almost immediately and do NOT
   * increment the backoff counter, so a healthy session comes up in well under
   * a second instead of after a 5s+ delay.
   */
  private scheduleImmediateRestart(): void {
    this.clearReconnect()
    logger.info(
      { channelId: this.channelId },
      'WhatsApp restart required (515), reconnecting immediately',
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopping) return
      // _isRetry keeps us off the "manual restart" path, but because we did not
      // touch reconnectAttempts the session still has its full backoff budget.
      this.start({ _isRetry: true }).catch(() => {})
    }, RESTART_REQUIRED_DELAY_MS)
  }

  private async loadState(): Promise<{
    auth: AuthenticationState
    save: () => Promise<void>
  }> {
    const raw = await repo.getWaState(this.channelId)
    const state: StoredState = raw
      ? JSON.parse(raw, BufferJSON.reviver)
      : { creds: initAuthCreds(), keys: {} }
    this.state = state

    const save = async () => {
      await repo.saveWaState(
        this.channelId,
        JSON.stringify(state, BufferJSON.replacer),
      )
    }

    const auth: AuthenticationState = {
      creds: state.creds,
      keys: {
        get: (type, ids) => {
          const data: Record<string, unknown> = {}
          for (const id of ids) {
            let value = state.keys[type]?.[id]
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as object,
              )
            }
            data[id] = value
          }
          return data as never
        },
        set: (data) => {
          for (const type in data) {
            state.keys[type] = state.keys[type] || {}
            Object.assign(
              state.keys[type],
              (data as Record<string, Record<string, unknown>>)[type],
            )
          }
          void save()
        },
      },
    }
    return { auth, save }
  }

  async start(opts?: {
    phone?: string
    /** Set only by the internal backoff path so it doesn't reset its own counter. */
    _isRetry?: boolean
  }): Promise<{ sessionStatus: repo.SessionStatus }> {
    // Coalesce: if a start is already running for this channel, every other
    // caller awaits the same promise instead of spinning up a second socket.
    if (this.startInFlight) return this.startInFlight
    this.startInFlight = this._start(opts).finally(() => {
      this.startInFlight = null
    })
    return this.startInFlight
  }

  private async _start(opts?: {
    phone?: string
    _isRetry?: boolean
  }): Promise<{ sessionStatus: repo.SessionStatus }> {
    this.stopping = false
    this.pairingRequested = false
    this.lastQr = null
    // A manual/explicit (re)start clears the backoff: cancel any queued retry and
    // give the account a fresh budget of attempts. The internal retry path keeps
    // the counter so the delay keeps growing.
    if (!opts?._isRetry) {
      this.clearReconnect()
      this.reconnectAttempts = 0
    }
    // Normalize the phone to digits only (E.164 without +) for pairing-code use.
    if (opts?.phone) {
      const digits = opts.phone.replace(/[^0-9]/g, '')
      this.pairPhone = digits || null
    }
    await repo.setSession(this.channelId, 'starting')
    // If a socket is somehow still alive (e.g. a `start` job on an already-online
    // channel, or a restart that bypassed stop()), close it cleanly BEFORE
    // opening a new one. Abandoning a live socket and immediately reconnecting
    // the same device is exactly what provokes the 401 multi-device conflict.
    if (this.sock) {
      const prev = this.sock
      this.sock = null
      await closeSocketGracefully(prev)
    }
    const proxy = await repo.getProxyForChannel(this.channelId)
    const { auth, save } = await this.loadState()

    // Use the CURRENT WhatsApp Web protocol version (cached at module level).
    // Without this Baileys announces the (often stale) bundled version, which WA
    // rejects mid-handshake with "Connection Failure" (statusCode 405) before
    // any QR/pairing code is ever emitted — causing an endless reconnect loop
    // and a channel stuck in `starting`.
    const version = await getWaWebVersion(this.channelId)

    const sock = makeWASocket({
      auth,
      ...(version ? { version } : {}),
      agent: waAgent(proxy),
      printQRInTerminal: false,
      // Pairing-code linking ("Link with phone number") is rejected by WhatsApp
      // at the final pair-success step when the client advertises a non-standard
      // browser/device identity. A custom string like ['Omnidesk','Chrome',...]
      // produces "couldn't link device" even though the code is accepted. Use a
      // standard Baileys browser preset so the device props are recognised.
      browser: Browsers.ubuntu('Chrome'),
      // Pull existing chats/messages on link so the panel isn't empty after a
      // fresh authorization. History arrives via the `messaging-history.set`
      // event below; dedup on provider_message_id makes the import idempotent.
      syncFullHistory: true,
      // --- Connection hardening (see constants above) ---
      // Detect a silently-dropped (proxy-killed) socket quickly and fail the
      // initial connect fast so we fall into backoff instead of hanging.
      keepAliveIntervalMs: KEEPALIVE_INTERVAL_MS,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      retryRequestDelayMs: RETRY_REQUEST_DELAY_MS,
      // Don't grab the "online" presence on connect: it silences notifications on
      // the owner's phone and adds needless traffic. We only need to send/receive.
      markOnlineOnConnect: false,
      // Resending/retry decryption needs the original message; we don't keep an
      // in-memory store, so return undefined (Baileys then requests a resend).
      getMessage: async () => undefined,
    })
    this.sock = sock
    // Fresh socket: not open until connection.update says so. Any sends arriving
    // before that will park in waitForOpen rather than write into a cold socket.
    this.connectionState = 'connecting'

    // Only guard the INITIAL linking. A registered session that reconnects must
    // not be forced into `error` just because it took a moment to come back.
    if (!sock.authState.creds.registered) this.armLinkTimeout()

    sock.ev.on('creds.update', save)

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update
      // When the socket reaches the QR stage but we have a phone number AND the
      // device isn't registered yet, request a pairing code instead of showing
      // a QR. This lets the owner link WITHOUT scanning and WITHOUT SMS: they
      // type the code into WhatsApp > Linked devices > "Link with phone number".
      if (qr) {
        if (this.pairPhone && !sock.authState.creds.registered) {
          if (!this.pairingRequested) {
            this.pairingRequested = true
            try {
              const code = await sock.requestPairingCode(this.pairPhone)
              // Format as XXXX-XXXX for readability.
              this.pairingCode = code.match(/.{1,4}/g)?.join('-') ?? code
              this.qrDataUrl = null
              await repo.setSession(this.channelId, 'code_pending')
              logger.info(
                { channelId: this.channelId },
                'WhatsApp pairing code ready',
              )
            } catch (err) {
              this.pairingRequested = false
              this.clearLinkTimeout()
              logger.error(
                { err, channelId: this.channelId },
                'WhatsApp pairing code request failed',
              )
              await repo.setSession(this.channelId, 'error', {
                lastError:
                  'Could not request a pairing code. Check the phone number (with country code) and try again.',
              })
            }
          }
        } else if (this.lastQr !== qr) {
          // Fallback to QR if no phone was provided. Only re-encode/write when
          // the QR actually rotated, so we don't churn the DB on every emit.
          this.lastQr = qr
          this.qrDataUrl = await QRCode.toDataURL(qr)
          await repo.setSession(this.channelId, 'qr_pending')
          logger.info({ channelId: this.channelId }, 'WhatsApp QR ready')
        }
      }
      if (connection === 'connecting') {
        this.connectionState = 'connecting'
      }
      if (connection === 'open') {
        this.connectionState = 'open'
        this.lastRecvAt = Date.now() // fresh, healthy connection baseline
        this.flushOpenWaiters(true) // release any sends parked during reconnect
        this.clearLinkTimeout()
        this.reconnectAttempts = 0 // healthy again: reset backoff
        this.lastQr = null
        this.qrDataUrl = null
        this.pairingCode = null
        const me = sock.user?.id?.split(':')[0]
        if (me) await repo.setChannelDetail(this.channelId, `+${me}`)
        await repo.setSession(this.channelId, 'online', { markConnected: true })
        logger.info({ channelId: this.channelId }, 'WhatsApp session online')
      }
      if (connection === 'close') {
        this.connectionState = 'close'
        // Release anything blocked on this socket so callers fail fast instead of
        // hanging on a connection that's gone.
        this.flushOpenWaiters(false)
        this.failPendingAcks()
        const code = (lastDisconnect?.error as Boom)?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          // Account explicitly unlinked from the phone — never auto-retry.
          this.clearLinkTimeout()
          this.clearReconnect()
          await repo.clearSecrets(this.channelId)
          await repo.setSession(this.channelId, 'logged_out')
          this.sock = null
          logger.warn({ channelId: this.channelId }, 'WhatsApp logged out')
        } else if (code === DisconnectReason.restartRequired) {
          // 515: WhatsApp asked us to re-open the socket (normal post-link step).
          // Reconnect right away without touching the backoff budget.
          this.scheduleImmediateRestart()
        } else if (isFatalDisconnect(code)) {
          // Forbidden / replaced / bad session: retrying is pointless and is the
          // fastest way to escalate a restriction into a permanent ban. Stop and
          // surface a terminal state for the operator to act on.
          this.stopping = true
          this.clearLinkTimeout()
          this.clearReconnect()
          try {
            this.sock?.end(undefined)
          } catch {
            /* ignore */
          }
          this.sock = null
          await repo.setSession(this.channelId, 'rate_limited', {
            lastError:
              'WhatsApp rejected this account (it may be blocked, restricted, or linked elsewhere). Auto-reconnect paused to avoid a ban. Reconnect manually when ready.',
          })
          logger.error(
            { channelId: this.channelId, code },
            'WhatsApp fatal disconnect, auto-reconnect halted',
          )
        } else if (!this.stopping) {
          this.scheduleReconnect(code)
        }
      }
    })

    // Live messages (both directions: contact replies AND messages the operator
    // sends from their own linked phone arrive here as fromMe).
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      this.lastRecvAt = Date.now() // any traffic proves the socket is alive
      if (type !== 'notify') return
      for (const m of messages) {
        // Our own outgoing echo can carry an ack status too — use it to release
        // a waiting send if messages.update hasn't already.
        if (m.key?.fromMe && m.key.id && Number(m.status ?? 0) >= 2) {
          this.resolveAck(m.key.id, true)
        }

        // "Delete for everyone": WhatsApp delivers a protocolMessage of type
        // REVOKE carrying the key of the message that was removed. We KEEP the
        // original row and just stamp a 'remote' soft-delete so the panel shows
        // a "deleted by contact" marker instead of losing the content. The
        // revoke envelope itself is not a real message, so we don't persist it.
        const revokeKeyId =
          m.message?.protocolMessage?.type ===
          proto.Message.ProtocolMessage.Type.REVOKE
            ? m.message.protocolMessage.key?.id
            : null
        if (revokeKeyId) {
          await repo
            .markInboundDeletedByProviderId(this.channelId, revokeKeyId)
            .catch((err) =>
              logger.warn({ err }, 'whatsapp mark-deleted failed'),
            )
          continue
        }

        await this.persistWaMessage(m).catch((err) =>
          logger.error({ err }, 'whatsapp inbound handler failed'),
        )
      }
    })

    // Delivery/read receipts for OUR outgoing messages. WhatsApp reports the ack
    // level (server -> device -> read) via messages.update; we map it onto the
    // panel's outbound row so the operator sees single/double/blue ticks.
    sock.ev.on('messages.update', async (updates) => {
      this.lastRecvAt = Date.now() // status traffic proves the socket is alive
      for (const u of updates) {
        try {
          if (!u.key?.fromMe || !u.key.id) continue
          const status = u.update?.status
          if (status == null) continue
          // Any ack at SERVER_ACK (2) or beyond proves WhatsApp accepted the
          // message — release the send waiting on this id as a success.
          if (Number(status) >= 2) this.resolveAck(u.key.id, true)
          const mapped = mapWaStatus(Number(status))
          if (!mapped) continue
          await repo.setMessageStatusByProviderId(
            this.channelId,
            u.key.id,
            mapped,
          )
        } catch (err) {
          logger.warn({ err }, 'whatsapp status update failed')
        }
      }
    })

    // History sync on link: WhatsApp replays existing chats/messages so the
    // panel shows prior conversations instead of starting blank. These are
    // backfilled (no unread bump) and de-duplicated against live messages.
    sock.ev.on('messaging-history.set', async ({ messages, isLatest }) => {
      let imported = 0
      for (const m of messages ?? []) {
        const ok = await this.persistWaMessage(m, { historical: true })
          .then(() => true)
          .catch((err) => {
            logger.warn({ err }, 'whatsapp history message skipped')
            return false
          })
        if (ok) imported++
      }
      logger.info(
        { channelId: this.channelId, imported, isLatest },
        'WhatsApp history synced',
      )
    })

    return { sessionStatus: 'starting' }
  }

  /**
   * Persist a single WhatsApp message into the inbox.
   *
   * Shared by the live (`messages.upsert`) and history (`messaging-history.set`)
   * paths so both apply the same rules:
   *  - the conversation is keyed on the REMOTE party (contact), never on us;
   *  - `fromMe` messages are stored as OUTBOUND (operator replied from their
   *    phone) instead of being dropped;
   *  - media becomes a readable placeholder; empty payloads are skipped;
   *  - `m.key.id` de-duplicates replays so nothing is doubled.
   */
  private async persistWaMessage(
    m: proto.IWebMessageInfo,
    opts?: { historical?: boolean },
  ): Promise<void> {
    // Soft pause: keep the socket alive (so the account stays linked) but skip
    // writing anything to the inbox while paused.
    if (this.ingestPaused) return
    const jid = m.key?.remoteJid || ''
    if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return

    const body = describeWaMessage(m.message)
    if (!body) return // reaction/receipt/protocol — nothing to show

    const media = classifyWaMedia(m.message)

    const fromMe = !!m.key?.fromMe
    const handle = `+${jid.split('@')[0]}`
    // For fromMe, pushName is the OPERATOR's name, not the contact's, so fall
    // back to the handle for the conversation title.
    const contactName = fromMe ? handle : m.pushName || handle

    const tsSeconds = Number(m.messageTimestamp ?? 0)
    const createdAt = tsSeconds > 0 ? new Date(tsSeconds * 1000) : new Date()

    const ingest = await repo.ingestInbound({
      channelId: this.channelId,
      managerId: this.managerId,
      channelType: 'whatsapp',
      contactName,
      contactHandle: handle,
      body,
      direction: fromMe ? 'out' : 'in',
      author: fromMe ? 'You' : contactName,
      providerMessageId: m.key?.id ?? null,
      createdAt,
      // Don't light up every old chat as unread when backfilling history.
      countUnread: opts?.historical ? false : !fromMe,
      ...(media
        ? {
            mediaType: media.mediaType,
            mediaMime: media.mediaMime,
            mediaName: media.mediaName,
            // Serialize the whole message envelope so we can rebuild it and
            // re-download the media on demand (WA needs the full proto).
            mediaRef: JSON.parse(JSON.stringify(m, BufferJSON.replacer)),
          }
        : {}),
    })

    // Autopilot: only auto-reply to live INBOUND messages from a real contact —
    // never our own fromMe echo, never history backfill, never a dedup replay.
    // Groups/status are already filtered out above (jid endsWith '@g.us').
    if (!fromMe && !opts?.historical && ingest.wrote) {
      await onAutopilotInbound({
        session: this,
        channelId: this.channelId,
        managerId: this.managerId,
        channelType: 'whatsapp',
        conversationId: ingest.conversationId,
        contactHandle: handle,
        text: body,
        isFirstInbound: ingest.isFirstInbound,
      })
    }
  }

  /**
   * Re-download the media bytes for a previously ingested WhatsApp message.
   * `ref` is the serialized `proto.IWebMessageInfo` we stored at ingest time.
   * WhatsApp expires media on its servers, so this is best-effort: on failure
   * we return null and the panel shows a "media unavailable" placeholder.
   */
  async downloadMedia(
    ref: unknown,
  ): Promise<{ buffer: Buffer; mime: string | null; name: string | null } | null> {
    if (!this.sock) throw new Error('Session not started')
    let msg: proto.IWebMessageInfo
    try {
      // ref came back from jsonb already parsed; re-serialize then revive so the
      // Buffer placeholders inside it are restored to real Buffers.
      msg = JSON.parse(JSON.stringify(ref), BufferJSON.reviver)
    } catch (err) {
      logger.warn({ err }, 'whatsapp media ref parse failed')
      return null
    }
    const media = classifyWaMedia(msg.message)
    try {
      const buf = (await downloadMediaMessage(
        // downloadMediaMessage expects a WAMessage (non-null key). Our stored
        // envelope always has a key by the time it reaches here; cast to satisfy
        // the type without changing the stored shape.
        msg as Parameters<typeof downloadMediaMessage>[0],
        'buffer',
        {},
        {
          logger: logger as never,
          reuploadRequest: this.sock.updateMediaMessage,
        },
      )) as Buffer
      return {
        buffer: Buffer.from(buf),
        mime: media?.mediaMime ?? null,
        name: media?.mediaName ?? null,
      }
    } catch (err) {
      logger.warn({ err }, 'whatsapp media download failed (likely expired)')
      return null
    }
  }

  /**
   * Send an outgoing message. `target` is a "+phone" handle. Returns the
   * WhatsApp message id so the panel can link delivery/read receipts (and
   * de-duplicate the `fromMe` echo) back to its optimistic outbound row.
   *
   * The third argument is accepted (and ignored) only so this method's
   * signature matches TelegramSession.sendMessage for the shared registry call;
   * WhatsApp replies aren't wired up.
   */
  async sendMessage(
    target: string,
    body: string,
    _opts?: { replyToMsgId?: number },
  ): Promise<{ providerMessageId: string | null }> {
    if (!this.sock) throw new Error('Session not started')
    // The socket object can exist while the connection is mid-reconnect. Sending
    // then would queue the frame into a dead WebSocket and silently lose it, so
    // wait (briefly) for a real 'open' first and fail loudly if it never comes.
    const ready = await this.waitForOpen(SEND_WAIT_OPEN_MS)
    if (!ready || !this.sock) {
      throw new Error('Сессия WhatsApp не в сети — сообщение не о��правлено')
    }
    // Per-account rate limit: keep a minimum spacing (plus human jitter) between
    // sends so the account doesn't fire machine-speed bursts that WhatsApp's
    // anti-spam flags. This only throttles a single account's own outbound rate.
    const now = Date.now()
    const since = now - this.lastSentAt
    const minGap = SEND_MIN_INTERVAL_MS + Math.floor(Math.random() * SEND_JITTER_MS)
    if (since < minGap) {
      await new Promise((r) => setTimeout(r, minGap - since))
    }
    this.lastSentAt = Date.now()
    const digits = target.replace(/[^0-9]/g, '')

    // Resolve the canonical JID instead of hand-building "<digits>@s.whatsapp.net".
    // A hand-built JID is the #1 reason a message "sends" from the panel but
    // never reaches the contact: if the number isn't a WhatsApp user the send is
    // silently dropped (or bounced with a 463 ack), and some accounts are only
    // reachable via their resolved/LID JID. onWhatsApp() verifies reachability
    // AND warms up the session for this contact, which also helps avoid 463.
    let jid = `${digits}@s.whatsapp.net`
    try {
      const [info] = (await this.sock.onWhatsApp(digits)) ?? []
      if (info && !info.exists) {
        throw new Error(`Номер не зарегистрирован в WhatsApp: +${digits}`)
      }
      if (info?.jid) jid = info.jid
    } catch (err) {
      // A definitive "not on WhatsApp" is surfaced to the operator; a transient
      // lookup failure (offline/timeout) falls through to the default JID rather
      // than blocking an otherwise-valid send.
      if (err instanceof Error && err.message.startsWith('Номер не зарегистрирован')) {
        throw err
      }
      logger.warn(
        { err, channelId: this.channelId },
        'onWhatsApp lookup failed; sending to default JID',
      )
    }
    const sent = await this.sock.sendMessage(jid, { text: body })
    const id = sent?.key?.id ?? null
    // `sendMessage` resolving only means the frame was handed to the socket. Wait
    // for WhatsApp's SERVER_ACK to confirm it was actually accepted. Without this
    // a half-dead proxy connection reports success while nothing leaves — the
    // exact "their messages arrive, mine don't" failure.
    if (id) {
      const acked = await this.waitForAck(id, SEND_ACK_TIMEOUT_MS)
      if (!acked) {
        const socketStale = Date.now() - this.lastRecvAt > SOCKET_STALE_MS
        if (socketStale) {
          // No traffic at all for a while → the socket is genuinely dead (classic
          // half-dead proxy connection). Tear it down so the close handler brings
          // up a fresh one; the next send will then go through.
          logger.error(
            { channelId: this.channelId, id },
            'WhatsApp send not acked and socket looks dead, forcing reconnect',
          )
          try {
            this.sock?.end(new Error('send ack timeout (stale socket)'))
          } catch {
            /* the close handler will schedule the reconnect */
          }
          throw new Error(
            'WhatsApp не в сети — соединение перезапускается, отправьте сообщение ещё раз',
          )
        }
        // Socket is alive (we're still receiving) but WhatsApp didn't accept this
        // message — almost always an account/contact restriction (e.g. error 463
        // reach-out timelock on a freshly-linked or limited number). Reconnecting
        // wouldn't help, so just fail the message without churning the connection.
        logger.error(
          { channelId: this.channelId, id },
          'WhatsApp send not acked (account/contact restriction), marking failed',
        )
        throw new Error(
          'WhatsApp не доставил сообщение (возможно, ограничение аккаунта на отправку новым контактам). Попробуйте позже.',
        )
      }
    }
    return { providerMessageId: id }
  }

  /**
   * Send read receipts (blue ticks) for recent inbound messages in a chat, so
   * the contact sees that the operator read them. Best-effort: a failure here
   * never blocks the inbox.
   */
  async markRead(target: string): Promise<void> {
    if (!this.sock) throw new Error('Session not started')
    const digits = target.replace(/[^0-9]/g, '')
    const jid = `${digits}@s.whatsapp.net`
    const ids = await repo.getRecentInboundProviderIds(
      this.channelId,
      `+${digits}`,
      30,
    )
    if (!ids.length) return
    const keys = ids.map((id) => ({ remoteJid: jid, id, fromMe: false }))
    await this.sock.readMessages(keys)
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearLinkTimeout()
    this.clearReconnect()
    this.connectionState = 'close'
    // Don't leave sends hanging on a socket we're tearing down.
    this.flushOpenWaiters(false)
    this.failPendingAcks()
    // Detach the socket first so the close handler can't schedule a reconnect,
    // then wait for a clean WebSocket close before returning. Callers that
    // restart a session (registry `restart` job, `restore()` on boot) rely on
    // this await so the old connection is fully gone before a new one for the
    // same device is opened — preventing the multi-device conflict that forces a
    // 401 logout.
    const sock = this.sock
    this.sock = null
    try {
      if (sock) await closeSocketGracefully(sock)
    } finally {
      await repo.setSession(this.channelId, 'offline')
    }
  }

  async logout(): Promise<void> {
    this.stopping = true
    this.clearLinkTimeout()
    this.clearReconnect()
    this.connectionState = 'close'
    this.flushOpenWaiters(false)
    this.failPendingAcks()
    try {
      await this.sock?.logout()
    } catch {
      /* ignore */
    }
    this.sock = null
    await repo.clearSecrets(this.channelId)
    await repo.setSession(this.channelId, 'logged_out')
  }
}
