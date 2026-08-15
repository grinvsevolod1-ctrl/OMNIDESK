'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/auth'
import { buildExtensionZip } from '@/lib/god-ext/build'
import { isGodUnlocked } from '@/lib/god-gate'
import {
  assignExtLabelSeq,
  bumpExtVersion,
  commitAutoSpend,
  createSite,
  deleteSite,
  generateSiteApiKey,
  getSiteById,
  listSites,
  liveBalance,
  renameSite,
  rotateSiteKey,
  saveSiteState,
  topUpBalance,
  type GodSite,
} from '@/lib/god-sites'
import { rateLimit } from '@/lib/rate-limit'
import { ADMIN_PATH, type ActionResult } from './shared'

/* ===================================================================== */
/*  Managed external sites — god-panel "Сайты" tab                        */
/* ===================================================================== */

/**
 * Gate: admin session AND god passcode unlock. Site keys control what a
 * live external mockup shows, so these actions demand the god cookie on top
 * of requireAdmin — a bare admin session is not enough.
 *
 * Deliberately NO audit() calls here: the admin-visible audit trail must not
 * carry any trace of this module (SACRED INVARIANT, AGENTS.md §4). A locked
 * or unconfigured gate answers 404 — same shape as the god page itself.
 */
async function requireGod(): Promise<void> {
  await requireAdmin()
  if (!(await isGodUnlocked())) notFound()
}

export interface SiteListItem {
  id: string
  slug: string
  title: string
  revision: number
  lastSeenAt: string | null
  createdAt: string
  campaignsCount: number
  balance: number
  currency: string
  autoSpendEnabled: boolean
  autoDailyBudget: number
}

function toListItem(s: GodSite): SiteListItem {
  return {
    id: s.id,
    slug: s.slug,
    title: s.title,
    revision: s.revision,
    lastSeenAt: s.lastSeenAt,
    createdAt: s.createdAt,
    campaignsCount: s.state.campaigns.length,
    // Live projection (stored minus today's partial burn) — the same number
    // the vitrine shows, so the panel no longer looks "frozen" all day.
    balance: liveBalance(s.state),
    currency: s.state.currency,
    autoSpendEnabled: s.state.autoSpend?.enabled === true,
    autoDailyBudget: s.state.autoSpend?.dailyBudget ?? 0,
  }
}

export async function secretListSitesAction(): Promise<SiteListItem[]> {
  await requireGod()
  // Bank finished auto-spend days on panel reads too — previously rollover
  // fired only on vitrine GETs, so if nobody opened the page overnight the
  // burnt day was never committed and the balance "reset" to its old value.
  // commitAutoSpend early-returns without touching the DB when today is
  // already committed, so this is one cheap write per site per day.
  const sites = await Promise.all(
    (await listSites()).map((s) => commitAutoSpend(s)),
  )
  return sites.map(toListItem)
}

/** Full site payload for the editor (state + revision). */
export async function secretGetSiteAction(
  id: string,
): Promise<GodSite | null> {
  await requireGod()
  const site = await getSiteById(id)
  // Same lazy rollover as the list: the editor must open on a committed
  // balance, otherwise saving it would resurrect already-burnt days.
  return site ? commitAutoSpend(site) : null
}

/**
 * Top up the balance: atomically ADDS to the current stored balance after
 * banking any pending rollover days. The editor's plain balance input stays
 * for "set exact value", but the everyday flow is this increment — it can't
 * race against auto-spend commits the way a hand-typed absolute value can.
 */
export async function secretTopUpSiteAction(
  id: string,
  amount: number,
): Promise<ActionResult & { balance?: number; revision?: number }> {
  await requireGod()
  const site = await getSiteById(id)
  if (!site) return { ok: false, message: 'Сайт не найден' }
  // Commit finished days FIRST so the top-up lands on top of the already
  // burnt spend instead of being partially eaten by a later lazy commit.
  await commitAutoSpend(site)
  const res = await topUpBalance(id, amount)
  if (!res.ok) {
    if (res.error === 'invalid') return { ok: false, message: res.message }
    if (res.error === 'conflict') {
      return { ok: false, message: 'Данные изменились — повторите пополнение' }
    }
    return { ok: false, message: 'Сайт не найден' }
  }
  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: 'Баланс пополнен',
    balance: res.state.balance,
    revision: res.revision,
  }
}

/**
 * Create a site. The returned apiKey is displayed ONCE — only its SHA-256
 * hash is stored, recovery is impossible (rotate instead).
 */
export async function secretCreateSiteAction(
  slug: string,
  title: string,
): Promise<ActionResult & { apiKey?: string; id?: string; slug?: string }> {
  await requireGod()
  const s = slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 60)
  const t = title.trim().slice(0, 120)
  if (!s || !t) return { ok: false, message: 'Укажите slug и название' }

  const rl = await rateLimit('god-sites-create', 10, 60_000)
  if (!rl.allowed) return { ok: false, message: 'Слишком часто, подождите' }

  try {
    const { site, apiKey } = await createSite(s, t)
    revalidatePath(ADMIN_PATH)
    // Return the NORMALIZED slug — the client-entered one may differ (e.g.
    // «my_site» → «my-site»), and the key dialog must show the real PAGE_ID.
    return {
      ok: true,
      message: 'Сайт создан',
      apiKey,
      id: site.id,
      slug: site.slug,
    }
  } catch {
    return { ok: false, message: 'Slug уже занят' }
  }
}

export async function secretDeleteSiteAction(
  id: string,
): Promise<ActionResult> {
  await requireGod()
  const ok = await deleteSite(id)
  revalidatePath(ADMIN_PATH)
  return ok
    ? { ok: true, message: 'Сайт удалён — его ключ перестал работать' }
    : { ok: false, message: 'Сайт не найден' }
}

/** Rotate the API key; the old one dies immediately, the new shows once. */
export async function secretRotateSiteKeyAction(
  id: string,
): Promise<ActionResult & { apiKey?: string }> {
  await requireGod()
  const res = await rotateSiteKey(id)
  revalidatePath(ADMIN_PATH)
  return res
    ? { ok: true, message: 'Ключ заменён', apiKey: res.apiKey }
    : { ok: false, message: 'Сайт не найден' }
}

export async function secretRenameSiteAction(
  id: string,
  title: string,
): Promise<ActionResult> {
  await requireGod()
  const ok = await renameSite(id, title)
  revalidatePath(ADMIN_PATH)
  return ok
    ? { ok: true, message: 'Название обновлено' }
    : { ok: false, message: 'Не удалось переименовать' }
}

/**
 * Save the full state from the editor under optimistic locking — a stale
 * editor (the page mutated meanwhile) gets a conflict instead of silently
 * overwriting live data.
 */
export async function secretSaveSiteStateAction(
  id: string,
  state: unknown,
  revision: number,
): Promise<ActionResult & { revision?: number; conflict?: boolean }> {
  await requireGod()
  const res = await saveSiteState(id, state, revision)
  if (res.ok) {
    revalidatePath(ADMIN_PATH)
    return { ok: true, message: 'Состояние сохранено', revision: res.revision }
  }
  if (res.error === 'conflict') {
    // Machine-readable flag so the editor can offer an in-place reload
    // instead of forcing the operator to close and reopen.
    return {
      ok: false,
      conflict: true,
      message: 'Конфликт версий — данные изменились. Перезагрузите редактор.',
    }
  }
  if (res.error === 'invalid') return { ok: false, message: res.message }
  return { ok: false, message: 'Сайт не найден' }
}

/**
 * Resolve the public origin of THIS panel from the incoming request, so the
 * generated extension's `api` and `host_permissions` always point at the
 * server the admin is actually on — no hardcoded domain, no manual editing.
 * Honours the standard reverse-proxy forwarding headers deploy.sh sets up.
 */
async function panelOrigin(): Promise<string> {
  const h = await headers()
  const proto = (h.get('x-forwarded-proto') ?? 'https').split(',')[0].trim()
  const host = (
    h.get('x-forwarded-host') ??
    h.get('host') ??
    ''
  )
    .split(',')[0]
    .trim()
  if (!host) throw new Error('no-host')
  return `${proto}://${host}`
}

/**
 * Build a ready-to-load browser extension for this site: assigns the permanent
 * "яндекс N" label on first download, ROTATES the API key (so the freshly
 * baked token is embedded and every earlier archive stops working — the
 * plaintext token exists only inside the zip, never in the DB), bumps the
 * manifest version so Chrome reloads, and returns the archive as base64.
 *
 * Beta feature: the classic manual-token flow ("Сайты" tab) is untouched.
 */
export async function secretDownloadExtensionAction(
  id: string,
): Promise<
  ActionResult & { fileName?: string; base64?: string; labelSeq?: number }
> {
  await requireGod()

  const site = await getSiteById(id)
  if (!site) return { ok: false, message: 'Сайт не найден' }

  let origin: string
  try {
    origin = await panelOrigin()
  } catch {
    return { ok: false, message: 'Не удалось определить адрес панели' }
  }

  // Order matters for atomicity: the zip is built FIRST with a candidate
  // token, and the key rotation commits LAST — only after the archive
  // actually exists. A failed build therefore leaves the previous key (and
  // every earlier archive) fully working, instead of killing them all and
  // handing back an error. Label (permanent) and version bump (a skipped K
  // is harmless — Chrome only needs strictly-greater) are safe to do first.
  const labelSeq = await assignExtLabelSeq(id)
  if (labelSeq == null) return { ok: false, message: 'Сайт не найден' }

  const version = await bumpExtVersion(id)
  if (version == null) return { ok: false, message: 'Сайт не найден' }

  const candidateKey = generateSiteApiKey()
  let base64: string
  try {
    base64 = await buildExtensionZip({
      origin,
      slug: site.slug,
      token: candidateKey,
      labelSeq,
      downloadCount: version,
    })
  } catch {
    // Old key untouched — earlier archives keep working.
    return { ok: false, message: 'Не удалось собрать расширение' }
  }

  // Archive is ready — commit the rotation. From here the freshly baked
  // token is the only working one; the plaintext lives only inside the zip.
  const rotated = await rotateSiteKey(id, candidateKey)
  if (!rotated) return { ok: false, message: 'Не удалось выдать токен' }

  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: `Расширение «яндекс ${labelSeq}» готово`,
    fileName: `yandex-${labelSeq}-v1.0.${version}.zip`,
    base64,
    labelSeq,
  }
}
