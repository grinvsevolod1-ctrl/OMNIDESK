import 'server-only'

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { query } from './db'
import { autoDayKey, round2 } from './god-sites-sim'
import {
  applyAutoSpendSave,
  freezeToday,
  rolloverAutoSpend,
  rolloverDue,
  setAllTimeBaseline,
  type AllTimeEntry,
} from './god-sites-projection'
import { MAX_NUM, sanitizeState, str } from './god-sites-validation'
import type { GodSite, MutationResult, SiteState } from './god-sites-types'

/**
 * God-panel managed external sites ("управляемые сайты") — DB layer.
 *
 * Standalone HTML mockups (page3.html — кабинет «Директ Про») are hosted on a
 * separate domain and READ their data from OMNIDESK through
 * /api/ext/pages/{PAGE_ID}/* (contract in the mockup's API-INTEGRATION.md).
 * The page is a pure витрина: PAGE_ID (= slug here) identifies the page, the
 * Bearer token (= one-time API key) authenticates it, and no mutation ever
 * arrives from the page — ALL editing happens in the god-panel "Сайты" tab.
 *
 * This module owns everything that touches the DB (row mapping, key lookup,
 * revision-safe mutation, CRUD, the extension generator counters). The pure,
 * side-effect-free parts were split out along their natural seams and are
 * RE-EXPORTED below so every existing `@/lib/god-sites` import keeps working:
 *   - god-sites-types.ts       — types + period constants
 *   - god-sites-validation.ts  — input sanitization
 *   - god-sites-projection.ts  — auto-spend simulation + period projection
 *   - god-sites-sim.ts         — low-level curve math (pre-existing)
 *
 * SACRED INVARIANT (AGENTS.md §4): god-panel only. Never import this (or any
 * of the split-out modules) from regular admin/manager/curator code or from
 * lib/ai-console — enforced by lib/ai/isolation.test.ts.
 *
 * Concurrency: god-panel editors use optimistic locking. Every save carries
 * the editor's known revision; the UPDATE is guarded by `WHERE revision = $n`,
 * so a stale save loses the race atomically (no read-modify-write window) and
 * the caller gets a 'conflict' instead of silently clobbering newer data.
 */

// Re-export the split-out surface so `@/lib/god-sites` stays the single import
// site for consumers (routes, actions, tests, god-report). The curve math is
// re-exported from god-sites-sim as before.
export { autoDayFraction, autoDayKey } from './god-sites-sim'
export * from './god-sites-types'
export * from './god-sites-validation'
export * from './god-sites-projection'

/* ------------------------------ Key lookup ----------------------------- */

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** Generate the one-time API key (shown once at creation). */
function generateApiKey(): string {
  return randomBytes(24).toString('hex')
}

interface SiteRow {
  id: string
  slug: string
  title: string
  state: unknown
  revision: number
  last_seen_at: string | null
  created_at: string
  updated_at: string
  ext_label_seq: number | null
  ext_version: number
}

function toSite(r: SiteRow): GodSite {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    state: sanitizeState(r.state),
    revision: Number(r.revision),
    lastSeenAt: r.last_seen_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    extLabelSeq: r.ext_label_seq == null ? null : Number(r.ext_label_seq),
    extVersion: Number(r.ext_version ?? 0),
  }
}

/**
 * Resolve a site by its PAGE_ID (slug) AND plaintext API key in one shot.
 * The pair must match: a valid slug with a wrong token misses exactly like a
 * nonexistent slug — the API layer answers a bare 404 either way, so probing
 * cannot distinguish "page exists" from "page doesn't" (fail-closed, same
 * philosophy as the god gate). Also stamps last_seen_at ("жива ли страница").
 */
export async function getSiteBySlugAndKey(
  slug: string,
  key: string,
  opts?: { touch?: boolean },
): Promise<GodSite | null> {
  const s = (slug ?? '').trim().toLowerCase()
  if (!s || s.length > 60) return null
  if (!key || key.length < 16 || key.length > 128) return null
  const hash = hashApiKey(key)
  // Touch is throttled to once per 30s: pages poll every few seconds and SSE
  // re-resolves every 3s, so an unconditional UPDATE meant tens of thousands
  // of dead-row writes per page per day. The "на связи" indicator only needs
  // minute-level precision (isOnline window is 60s). The CTE keeps it one
  // round-trip: SELECT always answers, UPDATE fires only when stale.
  const rows = opts?.touch
    ? await query<SiteRow>(
        `WITH found AS (
           SELECT * FROM god_sites WHERE slug = $1 AND api_key_hash = $2
         ),
         touched AS (
           UPDATE god_sites SET last_seen_at = now()
            WHERE id IN (SELECT id FROM found)
              AND (last_seen_at IS NULL
                   OR last_seen_at < now() - interval '30 seconds')
         )
         SELECT * FROM found`,
        [s, hash],
      )
    : await query<SiteRow>(
        `SELECT * FROM god_sites WHERE slug = $1 AND api_key_hash = $2`,
        [s, hash],
      )
  return rows[0] ? toSite(rows[0]) : null
}

/* --------------------------- SSE stream tickets -------------------------- */

/**
 * Short-lived, single-purpose ticket for the SSE `/stream` endpoint (#7).
 *
 * EventSource cannot send an Authorization header, so the legacy stream URL
 * carries the raw API token as `?token=` — which then lands in nginx/CDN
 * access logs. A ticket replaces the raw token in that URL: the page mints one
 * with a normal header-authenticated request, then opens the stream with
 * `?ticket=`. The ticket is:
 *   - short-lived (TICKET_TTL_MS) — useless in logs seconds later;
 *   - signed with an HMAC over the site's api_key_hash (a server-only secret),
 *     so it can't be forged and it auto-invalidates the instant the key is
 *     rotated;
 *   - stateless — no DB/Redis row, verification only re-derives the HMAC.
 *
 * The stream endpoint still accepts a raw `?token=` for already-installed
 * extensions (their packaged client predates tickets), so this is purely
 * additive; new downloads use tickets and keep the token out of the URL.
 */
const TICKET_TTL_MS = 60_000

/** Mint a stream ticket after validating slug+key. Null if the pair is wrong. */
export async function issueStreamTicket(
  slug: string,
  key: string,
): Promise<string | null> {
  const site = await getSiteBySlugAndKey(slug, key)
  if (!site) return null
  const exp = Date.now() + TICKET_TTL_MS
  const payload = `${site.slug}.${exp}`
  const sig = createHmac('sha256', hashApiKey(key)).update(payload).digest('base64url')
  return `${exp}.${sig}`
}

/**
 * Verify a stream ticket for a slug and return the site (no touch). Null if the
 * ticket is malformed, expired, for another slug, or its signature doesn't
 * match the site's CURRENT key hash (rotation invalidates outstanding tickets).
 */
export async function verifyStreamTicket(
  slug: string,
  ticket: string,
): Promise<GodSite | null> {
  const s = (slug ?? '').trim().toLowerCase()
  if (!s) return null
  const dot = ticket.indexOf('.')
  if (dot <= 0) return null
  const exp = Number(ticket.slice(0, dot))
  const sig = ticket.slice(dot + 1)
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return null

  const rows = await query<SiteRow & { api_key_hash: string }>(
    `SELECT *, api_key_hash FROM god_sites WHERE slug = $1`,
    [s],
  )
  if (!rows[0]) return null
  const expected = createHmac('sha256', rows[0].api_key_hash)
    .update(`${s}.${exp}`)
    .digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return toSite(rows[0])
}

/* ------------------------------ Auto-spend ------------------------------ */

/**
 * In-process "already tried to commit this (site, day)" gate. The auto-spend
 * commit only has DB work to do on the FIRST read of a new day, but the public
 * /state endpoint is hit by every poller/SSE reconnect, so a burst of
 * concurrent first-reads of a new day would each fire a SELECT+UPDATE
 * (mutateSite) — one wins, the rest lose the revision race but still paid for
 * two round-trips. This gate collapses that burst: once a commit has been
 * attempted for a (siteId, dayKey) on this instance, further attempts within
 * COMMIT_GATE_MS skip the DB entirely and return the caller's snapshot (which
 * is already correct — today's spend is live-projected, not stored). The gate
 * is a best-effort optimisation, never a correctness boundary: the real
 * guarantee stays the revision-guarded UPDATE, and the map self-prunes.
 */
const commitGate = new Map<string, { day: string; at: number }>()
const COMMIT_GATE_MS = 60_000
const COMMIT_GATE_MAX = 20_000

function commitRecentlyTried(siteId: string, day: string, now: number): boolean {
  const hit = commitGate.get(siteId)
  return hit != null && hit.day === day && now - hit.at < COMMIT_GATE_MS
}

function markCommitTried(siteId: string, day: string, now: number): void {
  if (commitGate.size > COMMIT_GATE_MAX) {
    for (const [k, v] of commitGate) {
      if (now - v.at >= COMMIT_GATE_MS) commitGate.delete(k)
    }
  }
  commitGate.set(siteId, { day, at: now })
}

/**
 * Lazily commit finished auto-spend days into the stored balance. Called on
 * page reads; the revision-guarded UPDATE makes concurrent first-reads of a
 * new day race safely — exactly one commits, the rest see 'conflict' and
 * simply keep their (already correct) snapshot. Best-effort by design.
 */
export async function commitAutoSpend(
  site: GodSite,
  now: Date = new Date(),
): Promise<GodSite> {
  const a = site.state.autoSpend
  if (!a || !rolloverDue(site.state, now)) return site
  const today = autoDayKey(now, a.tzOffsetHours ?? 3)

  // Collapse the concurrent-first-read burst to a single DB attempt per
  // (site, day) per instance (see commitGate above).
  const nowMs = now.getTime()
  if (commitRecentlyTried(site.id, today, nowMs)) {
    // Lost the burst: re-read instead of serving the pre-rollover snapshot
    // (it would show yesterday not yet deducted → the midnight balance jump).
    return (await getSiteById(site.id)) ?? site
  }
  markCommitTried(site.id, today, nowMs)

  // Day math lives in rolloverAutoSpend (pure): the deduction equals exactly
  // what the vitrine showed for each finished day, and the day is frozen
  // into the ledger so later edits never rewrite it. Never moves the
  // committed day backwards (TZ shifted back) — no double charge.
  const res = await mutateSite(site.id, null, (s) =>
    rolloverAutoSpend(s, now) ?? { invalid: 'already committed' },
  )
  if (res.ok) return { ...site, state: res.state, revision: res.revision }
  if (res.error === 'conflict') return (await getSiteById(site.id)) ?? site
  return site
}

/**
 * Atomic top-up: ADDS to the current stored balance server-side, so the
 * operator never has to read-modify-write the number by hand (a hand-set
 * value races against auto-spend commits; an increment cannot). No revision
 * check by design — "add N" is valid no matter who edited what meanwhile.
 */
export async function topUpBalance(
  id: string,
  amount: number,
): Promise<MutationResult> {
  const a = round2(amount)
  if (!Number.isFinite(a) || a <= 0 || a > MAX_NUM) {
    return { ok: false, error: 'invalid', message: 'Некорректная сумма' }
  }
  const now = new Date()
  return mutateSite(id, null, (s) => {
    // Bank today's burnt part first: with an empty balance the live spend is
    // capped, and new money must only fund spend from NOW on — otherwise the
    // whole day's curve would "catch up" instantly on top-up.
    const rolled = rolloverAutoSpend(s, now) ?? s
    const frozen = freezeToday(rolled, now)
    return {
      ...frozen,
      balance: round2(Math.min(frozen.balance + a, MAX_NUM)),
    }
  })
}

/**
 * Set the «Всё время» baseline (see setAllTimeBaseline). No revision check —
 * like the top-up it only touches server-owned fields, so the editor adopts
 * the returned state/revision in place.
 */
export async function saveAllTimeBaseline(
  id: string,
  entries: Record<string, AllTimeEntry>,
): Promise<MutationResult> {
  const now = new Date()
  return mutateSite(id, null, (s) => setAllTimeBaseline(s, entries, now))
}

/**
 * Toggle the «Аккаунт заблокирован» flag. An emergency kill switch like the
 * top-up: no revision check by design — "block NOW" must win regardless of
 * who edited what meanwhile, and the flag flip cannot corrupt other fields.
 * The flag is stored as literal `true` or removed entirely (never `false`),
 * keeping unblocked states byte-identical to their pre-feature shape.
 */
export async function setSiteBlocked(
  id: string,
  blocked: boolean,
): Promise<MutationResult> {
  return mutateSite(id, null, (s) => {
    const { blocked: _prev, ...rest } = s
    return blocked ? { ...rest, blocked: true } : rest
  })
}

/* ------------------------- Revision-safe mutation ----------------------- */

/**
 * Apply a state transformation under optimistic locking. `expected` is the
 * revision the caller believes is current (from If-Match / body); pass null
 * to skip the check (contract §5 allows clients that don't track revisions).
 * The WHERE-guarded UPDATE makes the check-and-set atomic.
 */
async function mutateSite(
  siteId: string,
  expected: number | null,
  transform: (state: SiteState) => SiteState | { invalid: string },
): Promise<MutationResult> {
  const rows = await query<SiteRow>(`SELECT * FROM god_sites WHERE id = $1`, [
    siteId,
  ])
  if (!rows[0]) return { ok: false, error: 'not_found' }
  const current = toSite(rows[0])

  if (expected !== null && expected !== 0 && expected !== current.revision) {
    return { ok: false, error: 'conflict', revision: current.revision }
  }

  const next = transform(current.state)
  if ('invalid' in next) {
    return { ok: false, error: 'invalid', message: next.invalid }
  }

  const updated = await query<SiteRow>(
    `UPDATE god_sites
        SET state = $2::jsonb, revision = revision + 1, updated_at = now()
      WHERE id = $1 AND revision = $3
      RETURNING *`,
    [siteId, JSON.stringify(next), current.revision],
  )
  // Row vanished or revision moved between our read and write — a concurrent
  // writer won; report a conflict with the freshest revision we can get.
  if (!updated[0]) {
    const fresh = await query<SiteRow>(
      `SELECT revision FROM god_sites WHERE id = $1`,
      [siteId],
    )
    if (!fresh[0]) return { ok: false, error: 'not_found' }
    return { ok: false, error: 'conflict', revision: Number(fresh[0].revision) }
  }
  const site = toSite(updated[0])
  return { ok: true, revision: site.revision, state: site.state }
}

/* --------------------------- God-panel actions -------------------------- */

/*
 * NOTE: there are deliberately NO page-facing mutations. The contract is
 * read-only — page3.html never sends writes; every change flows through the
 * god-panel editor (saveSiteState below).
 */

export async function listSites(): Promise<GodSite[]> {
  const rows = await query<SiteRow>(
    `SELECT * FROM god_sites ORDER BY created_at DESC`,
  )
  return rows.map(toSite)
}

export async function getSiteById(id: string): Promise<GodSite | null> {
  const rows = await query<SiteRow>(`SELECT * FROM god_sites WHERE id = $1`, [
    id,
  ])
  return rows[0] ? toSite(rows[0]) : null
}

/**
 * Create a site. The key is PERMANENT (migration 137): plaintext is stored
 * alongside the hash by owner decision — this is a closed system and every
 * downloaded extension archive must keep working forever, which beats
 * hash-only storage here.
 */
export async function createSite(
  slug: string,
  title: string,
  initialState?: unknown,
): Promise<{ site: GodSite; apiKey: string }> {
  const apiKey = generateApiKey()
  // A brand-new site with auto-spend already on gets its anchor immediately
  // (prev = empty state → off→on transition).
  const state = applyAutoSpendSave(
    sanitizeState(initialState),
    sanitizeState(undefined),
    new Date(),
  )
  const rows = await query<SiteRow>(
    `INSERT INTO god_sites (slug, title, api_key_hash, api_key_plain, state)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING *`,
    [slug, title, hashApiKey(apiKey), apiKey, JSON.stringify(state)],
  )
  return { site: toSite(rows[0]), apiKey }
}

/**
 * The ONE permanent key for a site. Normal path: return the stored plaintext.
 * Legacy path (site created before migration 137 — plaintext is not
 * recoverable from the hash): mint a key ONCE, persist plaintext + hash
 * atomically-guarded (`api_key_plain IS NULL` in WHERE makes a concurrent
 * double-mint impossible — the loser re-reads the winner's key), and from
 * then on the key never changes. Old archives of a legacy site work until
 * this one final re-issue; after it, every archive is forever-valid.
 */
export async function getOrCreateSiteKey(id: string): Promise<string | null> {
  const existing = await query<{ api_key_plain: string | null }>(
    `SELECT api_key_plain FROM god_sites WHERE id = $1`,
    [id],
  )
  if (!existing[0]) return null
  if (existing[0].api_key_plain) return existing[0].api_key_plain

  const candidate = generateApiKey()
  const updated = await query<{ api_key_plain: string }>(
    `UPDATE god_sites
        SET api_key_plain = $2, api_key_hash = $3, updated_at = now()
      WHERE id = $1 AND api_key_plain IS NULL
      RETURNING api_key_plain`,
    [id, candidate, hashApiKey(candidate)],
  )
  if (updated[0]) return updated[0].api_key_plain
  // Lost the race — another request minted first; use theirs.
  const winner = await query<{ api_key_plain: string | null }>(
    `SELECT api_key_plain FROM god_sites WHERE id = $1`,
    [id],
  )
  return winner[0]?.api_key_plain ?? null
}

/**
 * Manual re-issue from the UI («Ротация» button) — the ONLY path that changes
 * the permanent key. All previously downloaded archives die at once; the
 * extension download flow deliberately does NOT call this anymore.
 */
export async function rotateSiteKey(
  id: string,
): Promise<{ apiKey: string } | null> {
  const apiKey = generateApiKey()
  const rows = await query<{ id: string }>(
    `UPDATE god_sites
        SET api_key_hash = $2, api_key_plain = $3, updated_at = now()
      WHERE id = $1 RETURNING id`,
    [id, hashApiKey(apiKey), apiKey],
  )
  return rows[0] ? { apiKey } : null
}

export async function deleteSite(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM god_sites WHERE id = $1 RETURNING id`,
    [id],
  )
  return Boolean(rows[0])
}

/**
 * God-panel full-state save (the "Сайты" tab editor). Same optimistic locking
 * as page mutations so a panel edit can't silently clobber a page edit.
 * applyAutoSpendSave freezes today's burnt part before any setting / campaign
 * change and keeps the server-owned ledger — see god-sites-projection.ts.
 */
export async function saveSiteState(
  id: string,
  rawState: unknown,
  expected: number | null,
): Promise<MutationResult> {
  const now = new Date()
  return mutateSite(id, expected, (prev) =>
    applyAutoSpendSave(sanitizeState(rawState), prev, now),
  )
}

export async function renameSite(
  id: string,
  title: string,
): Promise<boolean> {
  const t = str(title).trim()
  if (!t) return false
  const rows = await query<{ id: string }>(
    `UPDATE god_sites SET title = $2, updated_at = now()
      WHERE id = $1 RETURNING id`,
    [id, t],
  )
  return Boolean(rows[0])
}

/* ----------------------- Extension generator (beta) --------------------- */

/** Where the "яндекс N" numbering starts (see migration 136). */
export const EXT_LABEL_SEQ_START = 11

/**
 * Assign this site its permanent "яндекс N" number on first download, as
 * MAX(ext_label_seq)+1 across all sites (floor EXT_LABEL_SEQ_START). Once set
 * it never changes — subsequent downloads reuse it (COALESCE on the current
 * row makes the common path idempotent). Two CONCURRENT first-downloads of
 * different sites can still compute the same MAX+1 — the unique partial index
 * rejects the loser, so we retry once with a recomputed MAX instead of
 * bubbling a raw constraint violation to the UI.
 */
export async function assignExtLabelSeq(id: string): Promise<number | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rows = await query<{ ext_label_seq: number }>(
        `UPDATE god_sites AS g
            SET ext_label_seq = COALESCE(
                  g.ext_label_seq,
                  GREATEST(
                    $2::int,
                    COALESCE((SELECT MAX(ext_label_seq) FROM god_sites), $2::int - 1) + 1
                  )
                ),
                updated_at = now()
          WHERE g.id = $1
          RETURNING ext_label_seq`,
        [id, EXT_LABEL_SEQ_START],
      )
      return rows[0] ? Number(rows[0].ext_label_seq) : null
    } catch (e) {
      // 23505 = unique_violation: a concurrent first-download won the number.
      const code = (e as { code?: string })?.code
      if (code !== '23505' || attempt === 1) throw e
    }
  }
  return null
}

/**
 * Bump and return the per-site download counter → manifest version "1.0.K".
 * Chrome refuses to reload an unpacked extension whose version didn't change,
 * so every download must produce a strictly greater K.
 */
export async function bumpExtVersion(id: string): Promise<number | null> {
  const rows = await query<{ ext_version: number }>(
    `UPDATE god_sites SET ext_version = ext_version + 1, updated_at = now()
      WHERE id = $1 RETURNING ext_version`,
    [id],
  )
  return rows[0] ? Number(rows[0].ext_version) : null
}
