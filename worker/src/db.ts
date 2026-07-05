import pg from 'pg'
import { env } from './env.js'
import { logger } from './logger.js'

const { Pool, Client } = pg

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  ssl: env.databaseUrl.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined,
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
 * Dedicated LISTEN client (separate from the pool) that auto-reconnects.
 * Calls onNotify for every NOTIFY received on the given channel.
 */
export async function startListener(
  channel: string,
  onNotify: (payload: string) => void,
): Promise<void> {
  async function connect(): Promise<void> {
    const client = new Client({ connectionString: env.databaseUrl })
    client.on('notification', (msg) => {
      if (msg.channel === channel && msg.payload) onNotify(msg.payload)
    })
    client.on('error', (err) => {
      logger.error({ err }, `LISTEN ${channel} client error, reconnecting`)
      client.end().catch(() => {})
      setTimeout(connect, 2000)
    })
    await client.connect()
    await client.query(`LISTEN ${channel}`)
    logger.info(`Listening on Postgres channel "${channel}"`)
  }
  await connect()
}
