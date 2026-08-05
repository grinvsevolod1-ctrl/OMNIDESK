import { connect as netConnect } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type { ProxyConfig } from './repo.js'

export interface ProxyProbeResult {
  ok: boolean
  latencyMs?: number
  error?: string
  /**
   * Per-destination reachability through the proxy (socks5/http only).
   * `telegram` now means a REAL MTProto data-center TCP tunnel (not the Bot
   * API over HTTPS): GramJS talks MTProto to 149.154.x.x:443, so tunneling
   * api.telegram.org proved nothing about whether a login would work.
   * `https` is a generic web-tunnel check (kept for HTTP proxies which can
   * only ever serve web traffic anyway).
   */
  reach?: { telegram: boolean; https: boolean }
}

/**
 * Telegram production data centers (DC1/DC2/DC4). A proxy is "Telegram-ready"
 * if it can open a TCP tunnel to at least one — that is exactly what GramJS
 * will ask of it during a real MTProto session.
 */
const TELEGRAM_DCS: Array<{ host: string; port: number }> = [
  { host: '149.154.175.53', port: 443 }, // DC1
  { host: '149.154.167.51', port: 443 }, // DC2 (most RU accounts)
  { host: '149.154.167.91', port: 443 }, // DC4
]

/**
 * Test a proxy's reachability/usability.
 *
 *  - socks5: tunnel a raw TCP connection to real Telegram MTProto DCs through
 *    the SOCKS proxy (what GramJS actually does), plus a generic HTTPS probe.
 *  - http: HTTP CONNECT proxies cannot carry MTProto in GramJS at all — probe
 *    only generic HTTPS and report that Telegram is not supported.
 *  - mtproto: GramJS dials MTProxies itself, so we can only verify the TCP
 *    endpoint is reachable — a raw socket connect is the meaningful check.
 */
export async function probeProxy(
  p: ProxyConfig,
  timeoutMs = 8000,
): Promise<ProxyProbeResult> {
  const start = Date.now()
  try {
    if (p.kind === 'mtproto') {
      await tcpConnect(p.host, p.port, timeoutMs)
      return { ok: true, latencyMs: Date.now() - start }
    }

    if (p.kind === 'http') {
      // GramJS has no HTTP-CONNECT transport: an HTTP proxy can never carry a
      // Telegram session. Verify it tunnels web traffic and say so honestly.
      const https = await httpsThroughAgent(
        'https://www.gstatic.com/generate_204',
        httpAgent(p),
        timeoutMs,
      )
        .then((s) => s > 0)
        .catch(() => false)
      const latencyMs = Date.now() - start
      return https
        ? {
            ok: true,
            latencyMs,
            reach: { telegram: false, https: true },
            error:
              'HTTP-прокси не поддерживается Telegram (MTProto). Для Telegram используйте SOCKS5 или MTProto-прокси.',
          }
        : {
            ok: false,
            reach: { telegram: false, https: false },
            error: 'Прокси не пропускает HTTPS-трафик.',
          }
    }

    // socks5 — the real thing: tunnel TCP to actual MTProto DCs.
    const [telegram, https] = await Promise.all([
      anyDcReachable(p, timeoutMs),
      httpsThroughAgent(
        'https://www.gstatic.com/generate_204',
        socksAgent(p),
        timeoutMs,
      )
        .then((s) => s > 0)
        .catch(() => false),
    ])
    const reach = { telegram, https }
    const latencyMs = Date.now() - start

    if (telegram) return { ok: true, latencyMs, reach }
    if (https) {
      return {
        ok: true,
        latencyMs,
        reach,
        error:
          'Прокси туннелирует HTTPS, но серверы Telegram (MTProto DC) через него недоступны.',
      }
    }
    return {
      ok: false,
      reach,
      error: 'Прокси не пропускает трафик (ни Telegram DC, ни HTTPS).',
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** True if at least one Telegram DC accepts a TCP tunnel through the SOCKS proxy. */
async function anyDcReachable(
  p: ProxyConfig,
  timeoutMs: number,
): Promise<boolean> {
  const results = await Promise.all(
    TELEGRAM_DCS.map((dc) =>
      socksTcpConnect(p, dc.host, dc.port, timeoutMs).then(
        () => true,
        () => false,
      ),
    ),
  )
  return results.some(Boolean)
}

/**
 * Open a raw TCP connection to host:port THROUGH a SOCKS5 proxy — the exact
 * operation GramJS performs for an MTProto session. Uses a minimal SOCKS5
 * handshake (RFC 1928, username/password auth per RFC 1929).
 */
function socksTcpConnect(
  p: ProxyConfig,
  destHost: string,
  destPort: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: p.host, port: p.port })
    let settled = false
    const done = (err?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (err) reject(err)
      else resolve()
    }
    socket.setTimeout(timeoutMs)
    socket.once('timeout', () => done(new Error('SOCKS connection timed out')))
    socket.once('error', (err) => done(err))

    const useAuth = Boolean(p.username)
    let stage: 'greeting' | 'auth' | 'connect' = 'greeting'

    socket.once('connect', () => {
      // Greeting: offer no-auth (0x00) and user/pass (0x02) when configured.
      socket.write(
        useAuth
          ? Buffer.from([0x05, 0x02, 0x00, 0x02])
          : Buffer.from([0x05, 0x01, 0x00]),
      )
    })

    socket.on('data', (buf: Buffer) => {
      try {
        if (stage === 'greeting') {
          if (buf[0] !== 0x05) return done(new Error('Not a SOCKS5 proxy'))
          const method = buf[1]
          if (method === 0x02) {
            const u = Buffer.from(p.username ?? '', 'utf8')
            const pw = Buffer.from(p.password ?? '', 'utf8')
            socket.write(
              Buffer.concat([
                Buffer.from([0x01, u.length]),
                u,
                Buffer.from([pw.length]),
                pw,
              ]),
            )
            stage = 'auth'
            return
          }
          if (method !== 0x00) {
            return done(new Error('SOCKS5 proxy rejected auth methods'))
          }
          stage = 'connect'
          sendConnect()
          return
        }
        if (stage === 'auth') {
          if (buf[1] !== 0x00) {
            return done(new Error('SOCKS5 auth failed (bad login/password)'))
          }
          stage = 'connect'
          sendConnect()
          return
        }
        // connect reply
        if (buf[1] !== 0x00) {
          return done(new Error(`SOCKS5 connect refused (code ${buf[1]})`))
        }
        done()
      } catch (e) {
        done(e instanceof Error ? e : new Error(String(e)))
      }
    })

    function sendConnect() {
      // CONNECT to an IPv4 destination.
      const parts = destHost.split('.').map((n) => Number.parseInt(n, 10))
      socket.write(
        Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x01, ...parts]),
          Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff]),
        ]),
      )
    }
  })
}

/** Issue a HEAD request through a proxy agent and resolve with the HTTP status. */
function httpsThroughAgent(
  url: string,
  agent: SocksProxyAgent | HttpsProxyAgent<string>,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: 'HEAD', agent, timeout: timeoutMs },
      (res) => {
        res.resume() // drain
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('timeout', () => req.destroy(new Error('Proxy request timed out')))
    req.on('error', reject)
    req.end()
  })
}

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port })
    const done = (err?: Error) => {
      socket.destroy()
      if (err) reject(err)
      else resolve()
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done())
    socket.once('timeout', () => done(new Error('Connection timed out')))
    socket.once('error', (err) => done(err))
  })
}

/**
 * Build a GramJS proxy descriptor. GramJS supports SOCKS proxies and Telegram
 * MTProxies natively — it dials through them itself. HTTP proxies are NOT
 * supported by GramJS at all; passing one as SOCKS (the old behavior) caused
 * silent connection hangs, so now it's an explicit, actionable error.
 */
export function gramProxy(p: ProxyConfig | null) {
  if (!p) return undefined
  if (p.kind === 'mtproto') {
    return {
      ip: p.host,
      port: p.port,
      MTProxy: true as const,
      secret: p.secret ?? '',
    }
  }
  if (p.kind === 'http') {
    throw new Error(
      'HTTP-прокси не поддерживается для Telegram (MTProto). Назначьте SOCKS5 или MTProto-прокси.',
    )
  }
  // socks5 (GramJS expects socksType 5 or 4)
  return {
    ip: p.host,
    port: p.port,
    socksType: 5 as const,
    username: p.username,
    password: p.password,
  }
}

/** Standard Node agent for an HTTP CONNECT proxy (generic HTTPS traffic). */
function httpAgent(p: ProxyConfig) {
  const auth = p.username ? `${p.username}:${p.password ?? ''}@` : ''
  return new HttpsProxyAgent(`http://${auth}${p.host}:${p.port}`)
}

/** Standard Node agent for a SOCKS5 proxy (generic HTTPS traffic). */
function socksAgent(p: ProxyConfig) {
  const auth = p.username ? `${p.username}:${p.password ?? ''}@` : ''
  return new SocksProxyAgent(`socks5://${auth}${p.host}:${p.port}`)
}
