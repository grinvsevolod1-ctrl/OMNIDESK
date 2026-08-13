'use server'

import { revalidatePath } from 'next/cache'
import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/auth'
import { isGodUnlocked } from '@/lib/god-gate'
import {
  createSite,
  deleteSite,
  getSiteById,
  listSites,
  renameSite,
  rotateSiteKey,
  saveSiteState,
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
    balance: s.state.balance,
    currency: s.state.currency,
    autoSpendEnabled: s.state.autoSpend?.enabled === true,
    autoDailyBudget: s.state.autoSpend?.dailyBudget ?? 0,
  }
}

export async function secretListSitesAction(): Promise<SiteListItem[]> {
  await requireGod()
  return (await listSites()).map(toListItem)
}

/** Full site payload for the editor (state + revision). */
export async function secretGetSiteAction(
  id: string,
): Promise<GodSite | null> {
  await requireGod()
  return getSiteById(id)
}

/**
 * Create a site. The returned apiKey is displayed ONCE — only its SHA-256
 * hash is stored, recovery is impossible (rotate instead).
 */
export async function secretCreateSiteAction(
  slug: string,
  title: string,
): Promise<ActionResult & { apiKey?: string; id?: string }> {
  await requireGod()
  const s = slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 60)
  const t = title.trim().slice(0, 120)
  if (!s || !t) return { ok: false, message: 'Укажите slug и название' }

  const rl = await rateLimit('god-sites-create', 10, 60_000)
  if (!rl.allowed) return { ok: false, message: 'Слишком часто, подождите' }

  try {
    const { site, apiKey } = await createSite(s, t)
    revalidatePath(ADMIN_PATH)
    return { ok: true, message: 'Сайт создан', apiKey, id: site.id }
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
