import 'server-only'
import {
  Agent,
  ProxyAgent,
  buildConnector,
  fetch as undiciFetch,
  type Dispatcher,
} from 'undici'
import { SocksClient } from 'socks'
import type { ProxyKind } from './types'

/**
 * Server-side proxy routing for the webhook-style providers (VK, MAX, WhatsApp
 * Cloud). Unlike Telegram/WhatsApp-Baileys — which run inside the worker and
 * already tunnel their sockets through a proxy (see worker/src/proxy.ts) — these
 * providers previously talked to their HTTPS APIs DIRECTLY from Next.js, so
 * every outbound send left from the panel's own IP. That defeats the whole
 * point of assigning a proxy per account.
 *
 * This module builds an undici `Dispatcher` from a channel's proxy and routes
 * `fetch` through it, so ALL provider traffic (token validation, webhook
 * registration, message sends, read receipts, media up/downloads) exits via the
 * account's dedicated proxy IP. That keeps each account's footprint isolated and
 * consistent, which is exactly what avoids provider-side risk/blocks.
 *
 *  - http / https proxies → undici `ProxyAgent` (CONNECT tunneling built in).
 *  - socks5 proxies       → undici `Agent` with a custom `connect` that opens
 *    the TCP tunnel through the SOCKS server (via the `socks` package) and then
 *    upgrades to TLS for https destinations.
 *
 * Dispatchers are pooled per proxy so connections are reused across requests.
 */

export interface ProxyDescriptor {
  id: string
  kind: ProxyKind
  host: string
  port: number
  username: string | null
  password: string | null
}

/** Thrown when a proxy can't route plain HTTP(S) traffic (e.g. an MTProto proxy). */
export class ProxyUnsupportedError extends Error {}

// Default undici connector, reused to upgrade a raw SOCKS socket to TLS.
const tlsConnector = buildConnector({})

// Pool of dispatchers keyed by a stable signature so we reuse connections and
// don't leak an agent per request. Survives HMR via globalThis.
const globalForProxy = globalThis as unknown as {
  __proxyDispatchers?: Map<string, Dispatcher>
}
const pool: Map<string, Dispatcher> =
  globalForProxy.__proxyDispatchers ??
  (globalForProxy.__proxyDispatchers = new Map())

function signature(p: ProxyDescriptor): string {
  return `${p.id}:${p.kind}:${p.host}:${p.port}:${p.username ? 'a' : 'n'}`
}

function buildSocksDispatcher(p: ProxyDescriptor): Dispatcher {
  return new Agent({
    connect: (opts, callback) => {
      const protocol = (opts as { protocol?: string }).protocol ?? 'https:'
      const hostname = String((opts as { hostname?: string }).hostname ?? '')
      const rawPort = (opts as { port?: string | number }).port
      const port =
        rawPort != null && String(rawPort).length
          ? Number(rawPort)
          : protocol === 'https:'
            ? 443
            : 80

      SocksClient.createConnection({
        proxy: {
          host: p.host,
          port: p.port,
          type: 5,
          userId: p.username ?? undefined,
          password: p.password ?? undefined,
        },
        command: 'connect',
        destination: { host: hostname, port },
      })
        .then(({ socket }) => {
          socket.setNoDelay?.(true)
          if (protocol === 'https:') {
            // Upgrade the tunneled TCP socket to TLS via undici's connector.
            tlsConnector(
              { ...(opts as Record<string, unknown>), httpSocket: socket } as never,
              callback,
            )
          } else {
            callback(null, socket as never)
          }
        })
        .catch((err: unknown) => {
          callback(err instanceof Error ? err : new Error(String(err)), null)
        })
    },
  })
}

function buildDispatcher(p: ProxyDescriptor): Dispatcher {
  if (p.kind === 'socks5') {
    return buildSocksDispatcher(p)
  }
  if (p.kind === 'http') {
    const auth = p.username
      ? `Basic ${Buffer.from(`${p.username}:${p.password ?? ''}`).toString('base64')}`
      : undefined
    return new ProxyAgent({
      uri: `http://${p.host}:${p.port}`,
      token: auth,
    })
  }
  // mtproto proxies are a Telegram-only transport and cannot tunnel arbitrary
  // HTTPS — surface a clear error so the admin picks a socks5/http proxy.
  throw new ProxyUnsupportedError(
    'Этот прокси (MTProto) подходит только для Telegram. Для VK/MAX/WhatsApp назначьте socks5 или http прокси.',
  )
}

function getDispatcher(p: ProxyDescriptor): Dispatcher {
  const key = signature(p)
  const existing = pool.get(key)
  if (existing) return existing
  const dispatcher = buildDispatcher(p)
  pool.set(key, dispatcher)
  return dispatcher
}

/**
 * `fetch` that routes through `proxy` when provided, else falls back to the
 * platform fetch (direct). Returns a standard `Response`-compatible object
 * (undici's Response implements the same interface: ok/status/text/json/
 * arrayBuffer/body), so existing call sites need no changes beyond passing the
 * proxy through.
 */
export async function proxiedFetch(
  url: string,
  init: RequestInit,
  proxy?: ProxyDescriptor | null,
): Promise<Response> {
  if (!proxy) return fetch(url, init)
  const dispatcher = getDispatcher(proxy)
  return undiciFetch(url, {
    ...(init as Record<string, unknown>),
    dispatcher,
  } as never) as unknown as Response
}
