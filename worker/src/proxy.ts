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
   * Per-destination reachability through the proxy (socks5/http only). A proxy
   * can tunnel general HTTPS yet be blocked by WhatsApp's servers, so we test
   * both messengers and surface the breakdown — otherwise a WhatsApp-blocked
   * proxy would look "healthy" against a Telegram-only probe.
   */
  reach?: { telegram: boolean; whatsapp: boolean }
}

/**
 * Test a proxy's reachability/usability.
 *
 *  - socks5 / http: route an HTTPS request through the proxy agent to BOTH a
 *    Telegram and a WhatsApp Web endpoint. A 2xx/3xx/4xx response proves the
 *    proxy actually tunnels traffic to that destination (not just that the port
 *    is open). Testing both matters because some proxies are blocked by
 *    WhatsApp while still reaching Telegram.
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

    const agent = waAgent(p)
    // Probe both messengers in parallel; a thrown/timed-out request counts as
    // "not reachable" rather than aborting the whole check.
    const reachable = (url: string) =>
      httpsThroughAgent(url, agent, timeoutMs)
        .then((status) => status > 0)
        .catch(() => false)
    const [telegram, whatsapp] = await Promise.all([
      reachable('https://api.telegram.org/'),
      reachable('https://web.whatsapp.com/'),
    ])
    const reach = { telegram, whatsapp }
    const latencyMs = Date.now() - start

    // The proxy is usable if it reaches at least one messenger. We still flag
    // the case where WhatsApp specifically is blocked so the operator knows not
    // to assign it to a WhatsApp channel.
    if (telegram && whatsapp) {
      return { ok: true, latencyMs, reach }
    }
    if (telegram && !whatsapp) {
      return {
        ok: true,
        latencyMs,
        reach,
        error: 'WhatsApp недоступен через этот прокси (Telegram работает).',
      }
    }
    if (!telegram && whatsapp) {
      return {
        ok: true,
        latencyMs,
        reach,
        error: 'Telegram недоступен через этот прокси (WhatsApp работает).',
      }
    }
    return {
      ok: false,
      reach,
      error: 'Прокси не пропускает трафик ни к Telegram, ни к WhatsApp.',
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Issue a HEAD request through a proxy agent and resolve with the HTTP status. */
function httpsThroughAgent(
  url: string,
  agent: ReturnType<typeof waAgent>,
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
 * MTProxies natively (no agent needed) — it dials through them itself.
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
  // socks5 (GramJS expects socksType 5 or 4)
  return {
    ip: p.host,
    port: p.port,
    socksType: 5 as const,
    username: p.username,
    password: p.password,
  }
}

/**
 * Build an http(s)/socks agent for Baileys (WhatsApp Web), which routes its
 * WebSocket + media requests through a standard Node agent.
 */
export function waAgent(p: ProxyConfig | null) {
  if (!p) return undefined
  if (p.kind === 'http') {
    const auth = p.username ? `${p.username}:${p.password ?? ''}@` : ''
    return new HttpsProxyAgent(`http://${auth}${p.host}:${p.port}`)
  }
  // default to socks5 for 'socks5' (and ignore 'mtproto' for WhatsApp)
  const auth = p.username ? `${p.username}:${p.password ?? ''}@` : ''
  return new SocksProxyAgent(`socks5://${auth}${p.host}:${p.port}`)
}
