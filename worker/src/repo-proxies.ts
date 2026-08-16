import { query, one } from './db.js'
import { decrypt } from './crypto.js'

export interface ProxyConfig {
  kind: 'socks5' | 'http' | 'mtproto'
  host: string
  port: number
  username?: string
  password?: string
  secret?: string
}

interface ProxyRow {
  id: string
  kind: 'socks5' | 'http' | 'mtproto'
  host: string
  port: number
  username_enc: string | null
  password_enc: string | null
  secret_enc: string | null
}

// Explicit column list mirroring ProxyRow. The `alias` param lets it serve both
// the bare `FROM proxies` read and the joined `FROM proxies p` read below.
function proxyCols(alias = ''): string {
  const p = alias ? `${alias}.` : ''
  return `${p}id, ${p}kind, ${p}host, ${p}port, ${p}username_enc, ${p}password_enc, ${p}secret_enc`
}

function rowToProxyConfig(row: ProxyRow): ProxyConfig {
  return {
    kind: row.kind,
    host: row.host,
    port: Number(row.port),
    username: row.username_enc ? decrypt(row.username_enc) : undefined,
    password: row.password_enc ? decrypt(row.password_enc) : undefined,
    secret: row.secret_enc ? decrypt(row.secret_enc) : undefined,
  }
}

export async function getProxyForChannel(
  channelId: string,
): Promise<ProxyConfig | null> {
  const row = await one<ProxyRow>(
    `SELECT ${proxyCols('p')} FROM proxies p
     JOIN channels c ON c.proxy_id = p.id
     WHERE c.id = $1`,
    [channelId],
  )
  if (!row) return null
  return rowToProxyConfig(row)
}

/** Load a proxy config directly by its id (used by the admin health check). */
export async function getProxyById(id: string): Promise<ProxyConfig | null> {
  const row = await one<ProxyRow>(
    `SELECT ${proxyCols()} FROM proxies WHERE id = $1`,
    [id],
  )
  if (!row) return null
  return rowToProxyConfig(row)
}

export async function markProxy(
  proxyId: string,
  status: 'ok' | 'error',
  error: string | null,
  latencyMs?: number | null,
): Promise<void> {
  // latency_ms/last_checked_at exist after scripts/108; fall back gracefully
  // for deployments that haven't applied it yet.
  try {
    await query(
      `UPDATE proxies
          SET status = $2, last_error = $3,
              latency_ms = $4, last_checked_at = now()
        WHERE id = $1`,
      [proxyId, status, error, latencyMs ?? null],
    )
  } catch {
    await query(
      'UPDATE proxies SET status = $2, last_error = $3 WHERE id = $1',
      [proxyId, status, error],
    )
  }
}

/** A proxy row enriched with id/manager/latency for the failover picker. */
export interface ProxyPickRow {
  id: string
  manager_id: string
  latency_ms: number | null
  config: ProxyConfig
}

/**
 * All proxies assigned to Telegram channels of this manager — the candidates
 * the health sweep probes. Includes the channel each proxy currently serves.
 */
export async function listTelegramProxyAssignments(): Promise<
  Array<{ channelId: string; proxyId: string; managerId: string }>
> {
  const rows = await query<{
    channel_id: string
    proxy_id: string
    manager_id: string
  }>(
    `SELECT c.id AS channel_id, p.id AS proxy_id, p.manager_id
       FROM channels c
       JOIN proxies p ON p.id = c.proxy_id
      WHERE c.type = 'telegram' AND c.proxy_id IS NOT NULL`,
  )
  return rows.map((r) => ({
    channelId: r.channel_id,
    proxyId: r.proxy_id,
    managerId: r.manager_id,
  }))
}

/**
 * Healthy, UNASSIGNED-for-telegram proxies of one manager, fastest first —
 * the candidate pool for automatic failover. Respects the allocation rule
 * from scripts/040 (one proxy serves at most one account per channel type):
 * a proxy already backing another Telegram channel is excluded.
 */
export async function listFailoverProxyCandidates(
  managerId: string,
): Promise<ProxyPickRow[]> {
  const rows = await query<
    ProxyRow & { id: string; manager_id: string; latency_ms: number | null }
  >(
    `SELECT ${proxyCols('p')}, p.manager_id, p.latency_ms
       FROM proxies p
      WHERE p.manager_id = $1
        AND p.status = 'ok'
        AND p.kind IN ('socks5', 'mtproto')
        AND NOT EXISTS (
          SELECT 1 FROM channels c
           WHERE c.proxy_id = p.id AND c.type = 'telegram'
        )
      ORDER BY p.latency_ms ASC NULLS LAST, p.created_at ASC`,
    [managerId],
  )
  return rows.map((r) => ({
    id: r.id,
    manager_id: r.manager_id,
    latency_ms: r.latency_ms,
    config: rowToProxyConfig(r),
  }))
}

/**
 * Atomically repoint a channel at a new proxy. The WHERE guard keeps the
 * migration honest if an admin reassigned the proxy mid-sweep.
 */
export async function reassignChannelProxy(
  channelId: string,
  fromProxyId: string,
  toProxyId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE channels SET proxy_id = $3
      WHERE id = $1 AND proxy_id = $2
      RETURNING id`,
    [channelId, fromProxyId, toProxyId],
  )
  return rows.length > 0
}
