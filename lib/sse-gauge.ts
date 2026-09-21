import 'server-only'

import { randomUUID } from 'crypto'

/**
 * Concurrent-connection gauge for the SSE ext endpoint (`/api/ext/pages/{slug}
 * /stream`). Each open stream holds two live timers, an open socket and a DB
 * poll subscription, so one client opening many streams — or many clients
 * behind one NAT — could pin server resources even while staying under the
 * per-minute (re)connect rate limit. We cap the number of CONCURRENT streams
 * per IP and per token.
 *
 * Two correctness properties this module guarantees, both of which the old
 * in-route `Map<string, number>` counters lacked:
 *
 *  1. ATOMIC reserve (no TOCTOU). `acquire()` checks the caps and records the
 *     slot in a single synchronous step (memory) or a single Lua EVAL (Redis).
 *     The route must reserve BEFORE its first `await`, so a burst of concurrent
 *     opens can never all pass a check that ran before any of them incremented.
 *
 *  2. SELF-HEALING under cluster + crashes. Slots are stored with a timestamp
 *     and expire after STALE_MS unless refreshed (the route refreshes on every
 *     heartbeat, ~25s < STALE_MS). A crashed/leaked slot therefore drains on
 *     its own instead of pinning the counter forever. When Redis is configured
 *     (UPSTASH_REDIS_REST_* / KV_REST_API_*) the gauge is SHARED across
 *     instances, so the cap no longer silently multiplies by the instance
 *     count; without Redis it falls back to a correct per-process gauge, and
 *     any Redis hiccup fails open to that same per-process gauge so a legit
 *     viewer is never wrongly blocked.
 */

const MAX_PER_IP = Math.max(1, Number(process.env.EXT_SSE_MAX_PER_IP ?? 20))
const MAX_PER_TOKEN = Math.max(1, Number(process.env.EXT_SSE_MAX_PER_TOKEN ?? 40))

/**
 * A slot is considered live for this long after its last touch. The route
 * refreshes on each heartbeat (~25s), so a healthy stream stays well inside
 * the window; a slot that stops being refreshed (crash, killed instance,
 * lost socket) is purged on the next acquire.
 */
const STALE_MS = 90_000

export interface StreamSlot {
  /** Refresh the slot's timestamp so a long-lived stream isn't purged. */
  refresh: () => void
  /** Release the slot exactly once (idempotent). */
  release: () => void
}

export interface AcquireResult {
  ok: boolean
  /** Which cap was hit ('ip' | 'token'), when ok is false. */
  reason?: 'ip' | 'token'
  slot?: StreamSlot
}

/* ------------------------------ memory store ------------------------------ */

// key -> (member -> expiresAt)
const memIp = new Map<string, Map<string, number>>()
const memTok = new Map<string, Map<string, number>>()

function memLiveCount(
  store: Map<string, Map<string, number>>,
  key: string,
  now: number,
): number {
  const m = store.get(key)
  if (!m) return 0
  for (const [member, exp] of m) if (exp <= now) m.delete(member)
  if (m.size === 0) {
    store.delete(key)
    return 0
  }
  return m.size
}

function memAdd(
  store: Map<string, Map<string, number>>,
  key: string,
  member: string,
  exp: number,
): void {
  let m = store.get(key)
  if (!m) {
    m = new Map()
    store.set(key, m)
  }
  m.set(member, exp)
}

function memRemove(
  store: Map<string, Map<string, number>>,
  key: string,
  member: string,
): void {
  const m = store.get(key)
  if (!m) return
  m.delete(member)
  if (m.size === 0) store.delete(key)
}

/**
 * Synchronous, therefore atomic within this process: the check and the two
 * adds run with no `await` between them, so concurrent handlers cannot
 * interleave and over-admit.
 */
function memoryAcquire(ip: string, token: string, member: string): AcquireResult {
  const now = Date.now()
  if (memLiveCount(memIp, ip, now) >= MAX_PER_IP) return { ok: false, reason: 'ip' }
  if (memLiveCount(memTok, token, now) >= MAX_PER_TOKEN)
    return { ok: false, reason: 'token' }

  memAdd(memIp, ip, member, now + STALE_MS)
  memAdd(memTok, token, member, now + STALE_MS)

  let released = false
  return {
    ok: true,
    slot: {
      refresh: () => {
        const exp = Date.now() + STALE_MS
        memAdd(memIp, ip, member, exp)
        memAdd(memTok, token, member, exp)
      },
      release: () => {
        if (released) return
        released = true
        memRemove(memIp, ip, member)
        memRemove(memTok, token, member)
      },
    },
  }
}

/* ------------------------------- Redis store ------------------------------ */

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? ''
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? ''

function redisConfigured(): boolean {
  return REDIS_URL !== '' && REDIS_TOKEN !== ''
}

/**
 * Atomic acquire across BOTH sorted sets. Purges stale members first (score <
 * cutoff), then rejects if either cap is already reached, otherwise adds the
 * member to both and arms a TTL so an abandoned key disappears on its own.
 * Returns 0 = admitted, 1 = ip cap hit, 2 = token cap hit.
 */
const ACQUIRE_LUA = `
local cutoff = tonumber(ARGV[1]) - tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, cutoff)
redis.call('ZREMRANGEBYSCORE', KEYS[2], 0, cutoff)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 1 end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then return 2 end
redis.call('ZADD', KEYS[1], tonumber(ARGV[1]), ARGV[5])
redis.call('ZADD', KEYS[2], tonumber(ARGV[1]), ARGV[5])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[2]))
return 0
`.trim()

async function redisCmd(cmd: (string | number)[]): Promise<unknown | null> {
  try {
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${REDIS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify([cmd]),
      cache: 'no-store',
    })
    if (!res.ok) return null
    const data = (await res.json()) as Array<{ result?: unknown; error?: string }>
    if (!Array.isArray(data) || data[0]?.error) return null
    return data[0]?.result ?? null
  } catch {
    return null
  }
}

async function redisAcquire(
  ipKey: string,
  tokKey: string,
  member: string,
): Promise<AcquireResult | null> {
  const now = Date.now()
  const result = await redisCmd([
    'EVAL',
    ACQUIRE_LUA,
    '2',
    ipKey,
    tokKey,
    String(now),
    String(STALE_MS),
    String(MAX_PER_IP),
    String(MAX_PER_TOKEN),
    member,
  ])
  if (result == null) return null // Redis hiccup — caller falls back to memory.
  const code = Number(result)
  if (code === 1) return { ok: false, reason: 'ip' }
  if (code === 2) return { ok: false, reason: 'token' }

  let released = false
  return {
    ok: true,
    slot: {
      refresh: () => {
        const t = Date.now()
        // Best-effort; a missed refresh only risks early purge, which the
        // heartbeat interval (< STALE_MS) makes practically impossible.
        void redisCmd(['ZADD', ipKey, String(t), member])
        void redisCmd(['ZADD', tokKey, String(t), member])
        void redisCmd(['PEXPIRE', ipKey, String(STALE_MS)])
        void redisCmd(['PEXPIRE', tokKey, String(STALE_MS)])
      },
      release: () => {
        if (released) return
        released = true
        void redisCmd(['ZREM', ipKey, member])
        void redisCmd(['ZREM', tokKey, member])
      },
    },
  }
}

/* --------------------------------- public --------------------------------- */

/**
 * Reserve one concurrent-stream slot for (ip, token). MUST be awaited and
 * checked before the route creates the SSE stream, and BEFORE any other await,
 * so the reservation is atomic against a burst of concurrent opens. On success
 * the returned slot must be `refresh()`ed on each heartbeat and `release()`d
 * exactly once when the stream ends (abort/close/error).
 */
export async function acquireStreamSlot(
  ip: string,
  token: string,
): Promise<AcquireResult> {
  const member = randomUUID()
  if (redisConfigured()) {
    const viaRedis = await redisAcquire(
      `ext:sse:ip:${ip}`,
      `ext:sse:tok:${token}`,
      member,
    )
    if (viaRedis) return viaRedis
    // Redis unreachable — fail open to the per-process gauge (still enforced
    // on this instance) rather than blocking a legitimate viewer.
  }
  return memoryAcquire(ip, token, member)
}
