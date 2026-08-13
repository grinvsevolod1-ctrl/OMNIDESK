import 'server-only'

import { createHash, randomBytes } from 'crypto'
import { query } from './db'

/**
 * God-panel managed external sites ("управляемые сайты").
 *
 * Standalone HTML mockups (page3.html — кабинет «Директ Про») are hosted on a
 * separate domain and READ their data from OMNIDESK through
 * /api/ext/pages/{PAGE_ID}/* (contract in the mockup's API-INTEGRATION.md).
 * The page is a pure витрина: PAGE_ID (= slug here) identifies the page, the
 * Bearer token (= one-time API key) authenticates it, and no mutation ever
 * arrives from the page — ALL editing happens in the god-panel "Сайты" tab.
 * This module is the single data layer for both.
 *
 * SACRED INVARIANT (AGENTS.md §4): god-panel only. Never import this from
 * regular admin/manager/curator code or from lib/ai-console — enforced by
 * lib/ai/isolation.test.ts.
 *
 * Concurrency: god-panel editors use optimistic locking. Every save carries
 * the editor's known revision; the UPDATE is guarded by `WHERE revision = $n`,
 * so a stale save loses the race atomically (no read-modify-write window) and
 * the caller gets a 'conflict' instead of silently clobbering newer data.
 */

/* ------------------------------- Types --------------------------------- */

export const SITE_PERIODS = ['today', 'yesterday', 'week', 'month', 'all'] as const
export type SitePeriod = (typeof SITE_PERIODS)[number]

export interface SiteCampaign {
  id: string
  name: string
  status: 'running' | 'stopped'
  cost: number
  shows: number
  clicks: number
  goals: number
  bounce: number
  weeklyBudget: number
  strategy: string
  platform: string
  regions: string
  type: string
  startDate: string
  endDate: string
}

/** Metric fields that can be overridden per period (contract §3). */
export const PERIOD_METRIC_FIELDS = [
  'cost',
  'shows',
  'clicks',
  'goals',
  'bounce',
] as const
export type PeriodMetricField = (typeof PERIOD_METRIC_FIELDS)[number]
export type PeriodOverride = Partial<Pick<SiteCampaign, PeriodMetricField>>

export interface SiteState {
  /** Cabinet login shown in the page header / side menu / tab title. */
  login: string
  balance: number
  currency: string
  campaigns: SiteCampaign[]
  /** Optional per-period metric overlays, god-panel curated. */
  periodOverrides?: Partial<Record<SitePeriod, Record<string, PeriodOverride>>>
}

export interface GodSite {
  id: string
  slug: string
  title: string
  state: SiteState
  revision: number
  lastSeenAt: string | null
  createdAt: string
  updatedAt: string
}

export type MutationResult =
  | { ok: true; revision: number; state: SiteState }
  | { ok: false; error: 'conflict'; revision: number }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'invalid'; message: string }

/* ----------------------------- Validation ------------------------------ */

const MAX_CAMPAIGNS = 200
const MAX_STR = 300
const MAX_NUM = 1_000_000_000

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return fallback
  return Math.min(n, MAX_NUM)
}

function str(v: unknown, fallback = ''): string {
  if (typeof v !== 'string') return fallback
  return v.slice(0, MAX_STR)
}

/** Normalize arbitrary JSON into a well-formed SiteCampaign. */
export function sanitizeCampaign(
  raw: unknown,
  existing?: SiteCampaign,
): SiteCampaign {
  const r = (raw ?? {}) as Record<string, unknown>
  const base: SiteCampaign =
    existing ?? {
      id: '',
      name: '',
      status: 'stopped',
      cost: 0,
      shows: 0,
      clicks: 0,
      goals: 0,
      bounce: 0,
      weeklyBudget: 0,
      strategy: '',
      platform: '',
      regions: '',
      type: '',
      startDate: '',
      endDate: '',
    }
  return {
    id: 'id' in r ? str(r.id, base.id) : base.id,
    name: 'name' in r ? str(r.name, base.name) : base.name,
    status:
      r.status === 'running' || r.status === 'stopped'
        ? r.status
        : base.status,
    cost: 'cost' in r ? num(r.cost, base.cost) : base.cost,
    shows: 'shows' in r ? Math.round(num(r.shows, base.shows)) : base.shows,
    clicks:
      'clicks' in r ? Math.round(num(r.clicks, base.clicks)) : base.clicks,
    goals: 'goals' in r ? Math.round(num(r.goals, base.goals)) : base.goals,
    bounce: 'bounce' in r ? Math.min(num(r.bounce, base.bounce), 100) : base.bounce,
    weeklyBudget:
      'weeklyBudget' in r
        ? num(r.weeklyBudget, base.weeklyBudget)
        : base.weeklyBudget,
    strategy: 'strategy' in r ? str(r.strategy, base.strategy) : base.strategy,
    platform: 'platform' in r ? str(r.platform, base.platform) : base.platform,
    regions: 'regions' in r ? str(r.regions, base.regions) : base.regions,
    type: 'type' in r ? str(r.type, base.type) : base.type,
    startDate:
      'startDate' in r ? str(r.startDate, base.startDate) : base.startDate,
    endDate: 'endDate' in r ? str(r.endDate, base.endDate) : base.endDate,
  }
}

/** Normalize arbitrary JSON into a well-formed SiteState. */
export function sanitizeState(raw: unknown): SiteState {
  const r = (raw ?? {}) as Record<string, unknown>
  const campaigns = Array.isArray(r.campaigns)
    ? r.campaigns.slice(0, MAX_CAMPAIGNS).map((c) => sanitizeCampaign(c))
    : []
  const state: SiteState = {
    login: str(r.login).trim(),
    balance: num(r.balance),
    currency: str(r.currency, '$') || '$',
    campaigns,
  }
  if (r.periodOverrides && typeof r.periodOverrides === 'object') {
    const out: NonNullable<SiteState['periodOverrides']> = {}
    for (const p of SITE_PERIODS) {
      const perPeriod = (r.periodOverrides as Record<string, unknown>)[p]
      if (!perPeriod || typeof perPeriod !== 'object') continue
      const byId: Record<string, PeriodOverride> = {}
      for (const [cid, ov] of Object.entries(
        perPeriod as Record<string, unknown>,
      )) {
        if (!ov || typeof ov !== 'object') continue
        const clean: PeriodOverride = {}
        for (const f of PERIOD_METRIC_FIELDS) {
          if (f in (ov as Record<string, unknown>)) {
            clean[f] = num((ov as Record<string, unknown>)[f])
          }
        }
        if (Object.keys(clean).length > 0) byId[str(cid)] = clean
      }
      if (Object.keys(byId).length > 0) out[p] = byId
    }
    if (Object.keys(out).length > 0) state.periodOverrides = out
  }
  return state
}

export function normalizePeriod(v: unknown): SitePeriod {
  return SITE_PERIODS.includes(v as SitePeriod) ? (v as SitePeriod) : 'today'
}

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
  const rows = opts?.touch
    ? await query<SiteRow>(
        `UPDATE god_sites SET last_seen_at = now()
          WHERE slug = $1 AND api_key_hash = $2
          RETURNING *`,
        [s, hash],
      )
    : await query<SiteRow>(
        `SELECT * FROM god_sites WHERE slug = $1 AND api_key_hash = $2`,
        [s, hash],
      )
  return rows[0] ? toSite(rows[0]) : null
}

/* --------------------------- Period projection -------------------------- */

/** The exact `State` payload page3.html consumes (contract §6). */
export interface PageStatePayload {
  login: string
  period: SitePeriod
  balance: number
  currency: string
  campaigns: SiteCampaign[]
}

/**
 * Project the canonical state onto a period (contract §3): base campaign
 * fields + per-period metric overlays when the god panel curated them. With
 * no overlays every period returns the same data — explicitly allowed by the
 * contract. periodOverrides themselves are NOT exposed to the page, and the
 * payload carries nothing beyond the contract's `State` (no revision, no ids
 * of ours — the page is a dumb витрина).
 */
export function stateForPeriod(
  state: SiteState,
  period: SitePeriod,
): PageStatePayload {
  const overrides = state.periodOverrides?.[period]
  const campaigns =
    !overrides || period === 'today'
      ? state.campaigns
      : state.campaigns.map((c) =>
          overrides[c.id] ? { ...c, ...overrides[c.id] } : c,
        )
  return {
    login: state.login,
    period,
    balance: state.balance,
    currency: state.currency,
    campaigns,
  }
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

/** Create a site; the returned apiKey is shown ONCE and never recoverable. */
export async function createSite(
  slug: string,
  title: string,
  initialState?: unknown,
): Promise<{ site: GodSite; apiKey: string }> {
  const apiKey = generateApiKey()
  const state = sanitizeState(initialState)
  const rows = await query<SiteRow>(
    `INSERT INTO god_sites (slug, title, api_key_hash, state)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING *`,
    [slug, title, hashApiKey(apiKey), JSON.stringify(state)],
  )
  return { site: toSite(rows[0]), apiKey }
}

/** Rotate the API key — the old key stops working immediately. */
export async function rotateSiteKey(
  id: string,
): Promise<{ apiKey: string } | null> {
  const apiKey = generateApiKey()
  const rows = await query<{ id: string }>(
    `UPDATE god_sites SET api_key_hash = $2, updated_at = now()
      WHERE id = $1 RETURNING id`,
    [id, hashApiKey(apiKey)],
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
 */
export async function saveSiteState(
  id: string,
  rawState: unknown,
  expected: number | null,
): Promise<MutationResult> {
  return mutateSite(id, expected, () => sanitizeState(rawState))
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
