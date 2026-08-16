import pg from 'pg'
import { env } from './env.js'
import { logger } from './logger.js'

const { Pool, Client } = pg

/**
 * Resolve TLS settings for the worker's Postgres connections.
 *
 * Mirrors the panel's policy (lib/db.ts): when TLS is used we VALIDATE the
 * server certificate by default so the connection — which carries every
 * decrypted secret — cannot be MITM'd. A custom CA can be supplied via
 * DATABASE_CA_CERT, and verification can be explicitly disabled with
 * DATABASE_SSL_NO_VERIFY=true (never the default). This is shared by BOTH the
 * pool and the dedicated LISTEN client so realtime notifications keep working
 * on managed providers that require `sslmode=require`.
 */
function resolveSslConfig(
  connectionString: string,
): false | { rejectUnauthorized: boolean; ca?: string } {
  const wantsSsl =
    connectionString.includes('sslmode=require') ||
    connectionString.includes('sslmode=verify') ||
    process.env.DATABASE_SSL === 'true'

  if (!wantsSsl) return false

  if (process.env.DATABASE_SSL_NO_VERIFY === 'true') {
    logger.warn(
      'DATABASE_SSL_NO_VERIFY=true — the database TLS certificate is NOT ' +
        'verified. This exposes the connection to MITM attacks; prefer ' +
        'setting DATABASE_CA_CERT instead.',
    )
    return { rejectUnauthorized: false }
  }

  const ca = process.env.DATABASE_CA_CERT
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) }
}

export const pool = new Pool({
  connectionString: env.databaseUrl,
  // Tunable: 10 is fine for a handful of accounts, but 20+ concurrently
  // backfilling channels serialize on the pool and slow every ingest write.
  max: Number(process.env.WORKER_PG_POOL_MAX || 10),
  ssl: resolveSslConfig(env.databaseUrl),
})

pool.on('error', (err) => {
  logger.error({ err }, 'pg pool error')
})

export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query(text, params)
  return res.rows as T[]
}

export async function one<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}

/**
 * How often the LISTEN client is pinged with `SELECT 1`. A silently dead TCP
 * connection (NAT timeout, firewall drop) does NOT reliably emit 'error' on
 * the pg Client — without an active probe the worker would keep "listening"
 * on a corpse and never see another NOTIFY until restart. The ping forces the
 * failure to surface so the reconnect logic kicks in within a minute.
 */
const LISTEN_KEEPALIVE_MS = 60_000

/**
 * Dedicated LISTEN client (separate from the pool) that auto-reconnects.
 * Calls onNotify for every NOTIFY received on the given channel.
 */
export async function startListener(
  channel: string,
  onNotify: (payload: string) => void,
): Promise<void> {
  // Guard against stacking reconnects: a dropped connection can fire multiple
  // 'error' events, and connect() can also throw — without this flag each would
  // schedule its own retry, leaking Client instances over time.
  let reconnectScheduled = false

  function scheduleReconnect(): void {
    if (reconnectScheduled) return
    reconnectScheduled = true
    setTimeout(() => {
      reconnectScheduled = false
      connect().catch((err) => {
        logger.error({ err }, `LISTEN ${channel} reconnect failed`)
        scheduleReconnect()
      })
    }, 2000)
  }

  async function connect(): Promise<void> {
    const client = new Client({
      connectionString: env.databaseUrl,
      // Same validated TLS policy as the pool so LISTEN works on managed
      // providers (sslmode=require) instead of silently failing to connect.
      ssl: resolveSslConfig(env.databaseUrl),
    })
    let keepalive: NodeJS.Timeout | null = null
    const teardown = (): void => {
      if (keepalive) {
        clearInterval(keepalive)
        keepalive = null
      }
      client.end().catch(() => {})
      scheduleReconnect()
    }
    client.on('notification', (msg) => {
      if (msg.channel === channel && msg.payload) onNotify(msg.payload)
    })
    client.on('error', (err) => {
      logger.error({ err }, `LISTEN ${channel} client error, reconnecting`)
      teardown()
    })
    await client.connect()
    await client.query(`LISTEN ${channel}`)
    // Active liveness probe: see LISTEN_KEEPALIVE_MS. If the ping fails, the
    // connection is dead even if no 'error' event ever fired — tear it down
    // and reconnect instead of listening on a corpse forever.
    keepalive = setInterval(() => {
      client.query('SELECT 1').catch((err) => {
        logger.error({ err }, `LISTEN ${channel} keepalive failed, reconnecting`)
        teardown()
      })
    }, LISTEN_KEEPALIVE_MS)
    keepalive.unref?.()
    logger.info(`Listening on Postgres channel "${channel}"`)
  }
  await connect()
}
