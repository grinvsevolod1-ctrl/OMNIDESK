import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import {
  helloUserAgent,
  OP,
  RPC_VERSION,
  USER_AGENT,
  WS_HOST,
  WS_ORIGIN,
  type MaxPacket,
  type MaxRequest,
} from './protocol.js'

export class MaxProtocolError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'protocol' | 'transport' = 'protocol',
  ) {
    super(message)
    this.name = 'MaxProtocolError'
  }
}

type PacketCallback = (packet: MaxPacket) => void
type ReconnectCallback = () => void

/**
 * Low-level MAX (OneMe) WebSocket client. One socket, seq-numbered RPC, JSON
 * frames. A faithful TypeScript port of the vkmax reference client, adapted to
 * `ws` and Node. Higher-level lifecycle/inbox logic lives in MaxSession; this
 * class only knows the wire protocol.
 */
export class MaxClient {
  private ws: WebSocket | null = null
  private seq = 0
  private deviceId: string | null = null
  private loggedIn = false
  private keepalive: NodeJS.Timeout | null = null
  private readonly pending = new Map<
    number,
    { resolve: (p: MaxPacket) => void; reject: (e: Error) => void }
  >()
  private onPacket: PacketCallback | null = null
  private onReconnectNeeded: ReconnectCallback | null = null

  get currentDeviceId(): string | null {
    return this.deviceId
  }
  get isLoggedIn(): boolean {
    return this.loggedIn
  }

  setPacketCallback(cb: PacketCallback): void {
    this.onPacket = cb
  }
  setReconnectCallback(cb: ReconnectCallback): void {
    this.onReconnectNeeded = cb
  }

  /** Open the socket and start the receive loop. Rejects on connect failure. */
  connect(): Promise<void> {
    if (this.ws) throw new MaxProtocolError('Already connected')
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_HOST, {
        origin: WS_ORIGIN,
        headers: { 'User-Agent': USER_AGENT },
        handshakeTimeout: 20_000,
      })
      this.ws = ws

      const onOpenError = (err: Error) => {
        reject(new MaxProtocolError(`connect failed: ${err.message}`, 'transport'))
      }
      ws.once('open', () => {
        ws.off('error', onOpenError)
        resolve()
      })
      ws.once('error', onOpenError)

      ws.on('message', (data) => this.handleMessage(data))
      ws.on('close', () => this.handleClose())
      ws.on('error', (err) => {
        // Post-open transport errors: surface to the session via reconnect.
        if (this.loggedIn && this.onReconnectNeeded) this.onReconnectNeeded()
        for (const { reject: rej } of this.pending.values()) {
          rej(new MaxProtocolError(`socket error: ${err.message}`, 'transport'))
        }
        this.pending.clear()
      })
    })
  }

  /** Close the socket and stop keepalive. Safe to call repeatedly. */
  disconnect(): void {
    this.stopKeepalive()
    if (this.ws) {
      try {
        this.ws.removeAllListeners()
        this.ws.close()
      } catch {
        /* already closing */
      }
      this.ws = null
    }
    for (const { reject } of this.pending.values()) {
      reject(new MaxProtocolError('disconnected', 'transport'))
    }
    this.pending.clear()
    this.loggedIn = false
  }

  /** Send an RPC and await the matching seq response (25s timeout). */
  invoke(
    opcode: number,
    payload: Record<string, unknown>,
    timeoutMs = 25_000,
  ): Promise<MaxPacket> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new MaxProtocolError('not connected', 'transport'))
    }
    const seq = ++this.seq
    const request: MaxRequest = { ver: RPC_VERSION, cmd: 0, seq, opcode, payload }

    return new Promise<MaxPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new MaxProtocolError(`opcode ${opcode} timed out`, 'transport'))
      }, timeoutMs)

      this.pending.set(seq, {
        resolve: (p) => {
          clearTimeout(timer)
          resolve(p)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })

      ws.send(JSON.stringify(request), (err) => {
        if (err) {
          this.pending.delete(seq)
          clearTimeout(timer)
          reject(new MaxProtocolError(`send failed: ${err.message}`, 'transport'))
        }
      })
    })
  }

  private handleMessage(data: WebSocket.RawData): void {
    let packet: MaxPacket
    try {
      packet = JSON.parse(data.toString())
    } catch {
      return // undecodable frame — ignore, matches reference behavior
    }
    const waiter = this.pending.get(packet.seq)
    if (waiter) {
      this.pending.delete(packet.seq)
      waiter.resolve(packet)
      return
    }
    // No matching seq: a server push (new message, receipt, typing, media ack).
    if (this.onPacket) this.onPacket(packet)
  }

  private handleClose(): void {
    this.stopKeepalive()
    // A clean close after login usually means the account logged out elsewhere;
    // an unexpected close means the network dropped. Either way, let the
    // session decide whether to revive.
    if (this.loggedIn && this.onReconnectNeeded) this.onReconnectNeeded()
  }

  /* --------------------------- Handshake / auth --------------------------- */

  private async hello(deviceId?: string): Promise<MaxPacket> {
    this.deviceId = deviceId ?? randomUUID()
    return this.invoke(OP.HELLO, {
      userAgent: helloUserAgent(),
      deviceId: this.deviceId,
    })
  }

  /**
   * Request an SMS code for `phone`. Returns the login token that must be
   * paired with the code in `signIn`. Sends the hello packet first.
   */
  async requestCode(phone: string): Promise<string> {
    await this.hello()
    const res = await this.invoke(OP.START_AUTH, {
      phone,
      type: 'START_AUTH',
      language: 'ru',
    })
    const token = (res.payload as { token?: string })?.token
    if (!token) {
      throw new MaxProtocolError('START_AUTH returned no token', 'protocol')
    }
    return token
  }

  /**
   * Submit the SMS code. On success MAX returns a profile and a long-lived
   * session token at payload.tokenAttrs.LOGIN.token — that is what we persist
   * (encrypted) and reuse via `loginByToken`.
   */
  async signIn(
    smsToken: string,
    code: string,
  ): Promise<{ sessionToken: string; phone: string | null }> {
    const res = await this.invoke(OP.CHECK_CODE, {
      token: smsToken,
      verifyCode: String(code),
      authTokenType: 'CHECK_CODE',
    })
    const payload = res.payload as {
      error?: string
      tokenAttrs?: { LOGIN?: { token?: string } }
      profile?: { contact?: { phone?: string } }
    }
    if (payload.error) throw new MaxProtocolError(payload.error, 'auth')
    const sessionToken = payload.tokenAttrs?.LOGIN?.token
    if (!sessionToken) {
      throw new MaxProtocolError('CHECK_CODE returned no session token', 'auth')
    }
    this.loggedIn = true
    this.startKeepalive()
    return { sessionToken, phone: payload.profile?.contact?.phone ?? null }
  }

  /**
   * Reconnect using a stored session token — no SMS. Reuses the same deviceId
   * as the original login when provided (MAX ties tokens to devices; a fresh
   * deviceId on every reconnect looks like credential theft and gets flagged).
   */
  async loginByToken(
    token: string,
    deviceId?: string,
  ): Promise<{ phone: string | null }> {
    await this.hello(deviceId)
    const res = await this.invoke(OP.LOGIN_BY_TOKEN, {
      interactive: true,
      token,
      chatsCount: 40,
      chatsSync: 0,
      contactsSync: 0,
      presenceSync: -1,
      draftsSync: 0,
    })
    const payload = res.payload as {
      error?: string
      profile?: { contact?: { phone?: string } }
    }
    if (payload.error) throw new MaxProtocolError(payload.error, 'auth')
    this.loggedIn = true
    this.startKeepalive()
    return { phone: payload.profile?.contact?.phone ?? null }
  }

  /* ------------------------------ Keepalive ------------------------------ */

  private startKeepalive(): void {
    if (this.keepalive) return
    this.keepalive = setInterval(() => {
      this.invoke(OP.PING, { interactive: false }, 15_000).catch(() => {
        // A missed ping means the socket is dead; trigger revival.
        if (this.onReconnectNeeded) this.onReconnectNeeded()
      })
    }, 30_000)
  }

  private stopKeepalive(): void {
    if (this.keepalive) {
      clearInterval(this.keepalive)
      this.keepalive = null
    }
  }
}
