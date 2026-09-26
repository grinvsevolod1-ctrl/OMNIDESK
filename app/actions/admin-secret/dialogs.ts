'use server'

import { requireAdmin } from '@/lib/auth'
import { query } from '@/lib/db'
import type { ChannelType } from '@/lib/types'
import { ADMIN_PATH, audit, type ActionResult } from './shared'
import { revalidatePath } from 'next/cache'

/**
 * God-only «Удаление диалогов» tab.
 *
 * A single powerful search over EVERY conversation in the system (all managers,
 * all channels, synthetic and real alike) plus a hard, irreversible delete.
 * Unlike the messenger's soft-delete (`deleted_at`) and the transfer tab's
 * reassign, `secretHardDeleteConversationsAction` runs a real
 * `DELETE FROM conversations`, which cascades to every dependent row
 * (messages, message reads, transfers, autopilot state, ai memory, …) through
 * the ON DELETE CASCADE / SET NULL constraints declared in scripts/*.sql — the
 * same mechanism the one-off purge migrations rely on. There is no undo.
 *
 * Everything funnels through the parameterised `query` helper (no string
 * interpolation into SQL) and re-checks `requireAdmin()` because a server action
 * is an independently reachable POST endpoint.
 */

/** Which timestamp column the date range applies to. */
export type DialogDateField = 'created_at' | 'last_message_at'

/** Narrow the population beyond the free-text query. */
export type DialogKindFilter = 'all' | 'real' | 'synthetic' | 'simulated'

export interface DialogSearchFilters {
  /** Free-text query — matched against contact, channel, manager and preview. */
  q?: string
  /** Also scan message bodies (slower EXISTS subquery) when true. */
  searchMessages?: boolean
  /** Restrict to one channel type, or 'all'. */
  channelType?: ChannelType | 'all'
  /** Restrict to one owning manager (managers.id), or 'all'. */
  managerId?: string | 'all'
  /** Restrict to one conversation status, or 'all'. */
  status?: string | 'all'
  /** Which column the from/to bounds apply to. */
  dateField?: DialogDateField
  /** Inclusive lower bound (ISO date), applied to `dateField`. */
  dateFrom?: string
  /** Exclusive-by-day upper bound (ISO date), applied to `dateField`. */
  dateTo?: string
  /** Only conversations with unread > 0. */
  unreadOnly?: boolean
  /** Population narrowing (real / synthetic / simulated). */
  kind?: DialogKindFilter
}

export interface DialogSearchRow {
  id: string
  contactName: string
  contactHandle: string
  contactUsername: string | null
  channelType: ChannelType
  channelName: string | null
  managerId: string | null
  managerName: string | null
  curatorName: string | null
  lastMessage: string
  lastMessageAt: string
  createdAt: string
  unread: number
  status: string | null
  godSynthetic: boolean
  isSimulated: boolean
  messageCount: number
}

export interface DialogSearchResult {
  rows: DialogSearchRow[]
  /** Total matches (may exceed rows.length when the cap is hit). */
  total: number
  /** Hard cap applied to the returned rows. */
  limit: number
  /**
   * Human-readable failure reason. When present the search could not run
   * (usually a DB connectivity / missing-column problem) — the UI shows this
   * instead of a blank 500 so the real cause is visible.
   */
  error?: string
}

const SEARCH_LIMIT = 300

/**
 * Search across ALL conversations. Every predicate is optional, so an empty
 * filter returns the most recent dialogs system-wide. Text search is
 * case-insensitive and, when `searchMessages` is on, also matches any message
 * body inside the thread.
 */
export async function secretSearchConversationsAction(
  filters: DialogSearchFilters,
): Promise<DialogSearchResult> {
  await requireAdmin()

  const where: string[] = []
  const params: unknown[] = []
  const p = (v: unknown) => {
    params.push(v)
    return `$${params.length}`
  }

  const q = filters.q?.trim()
  if (q) {
    const like = `%${q}%`
    const parts = [
      `c.contact_name ILIKE ${p(like)}`,
      `c.contact_handle ILIKE ${p(like)}`,
      `c.contact_username ILIKE ${p(like)}`,
      `c.last_message ILIKE ${p(like)}`,
      `ch.name ILIKE ${p(like)}`,
      `mgr.name ILIKE ${p(like)}`,
    ]
    // Direct id lookup — paste a conversation id straight into the box.
    parts.push(`c.id::text = ${p(q)}`)
    if (filters.searchMessages) {
      parts.push(
        `EXISTS (SELECT 1 FROM messages m
                  WHERE m.conversation_id = c.id
                    AND m.body ILIKE ${p(like)})`,
      )
    }
    where.push(`(${parts.join(' OR ')})`)
  }

  if (filters.channelType && filters.channelType !== 'all') {
    where.push(`c.channel_type = ${p(filters.channelType)}`)
  }

  if (filters.managerId && filters.managerId !== 'all') {
    where.push(`c.manager_id = ${p(filters.managerId)}`)
  }

  if (filters.status && filters.status !== 'all') {
    where.push(`c.status = ${p(filters.status)}`)
  }

  if (filters.unreadOnly) {
    where.push('c.unread > 0')
  }

  switch (filters.kind) {
    case 'real':
      where.push('c.god_synthetic = false AND c.is_simulated = false')
      break
    case 'synthetic':
      where.push('c.god_synthetic = true')
      break
    case 'simulated':
      where.push('c.is_simulated = true')
      break
    default:
      break
  }

  const dateField: DialogDateField =
    filters.dateField === 'last_message_at' ? 'last_message_at' : 'created_at'
  if (filters.dateFrom) {
    const d = new Date(filters.dateFrom)
    if (!Number.isNaN(d.getTime()))
      where.push(`c.${dateField} >= ${p(d.toISOString())}`)
  }
  if (filters.dateTo) {
    const d = new Date(filters.dateTo)
    if (!Number.isNaN(d.getTime())) {
      // Make the upper bound inclusive of the whole selected day.
      d.setHours(23, 59, 59, 999)
      where.push(`c.${dateField} <= ${p(d.toISOString())}`)
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  try {
    const countRows = await query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
         FROM conversations c
         LEFT JOIN channels ch ON ch.id = c.channel_id
         LEFT JOIN managers mgr ON mgr.id = c.manager_id
         ${whereSql}`,
      params,
    )
    const total = countRows[0]?.total ?? 0

    const rows = await query<{
      id: string
      contact_name: string
      contact_handle: string
      contact_username: string | null
      channel_type: ChannelType
      channel_name: string | null
      manager_id: string | null
      manager_name: string | null
      curator_name: string | null
      last_message: string
      last_message_at: string
      created_at: string
      unread: number
      status: string | null
      god_synthetic: boolean
      is_simulated: boolean
      message_count: number
    }>(
      `SELECT c.id, c.contact_name, c.contact_handle, c.contact_username,
              c.channel_type, ch.name AS channel_name,
              c.manager_id, mgr.name AS manager_name, cur.name AS curator_name,
              c.last_message, c.last_message_at, c.created_at, c.unread,
              c.status, c.god_synthetic, c.is_simulated,
              (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c
         LEFT JOIN channels ch ON ch.id = c.channel_id
         LEFT JOIN managers mgr ON mgr.id = c.manager_id
         LEFT JOIN managers cur ON cur.id = c.curator_id
         ${whereSql}
        ORDER BY c.${dateField} DESC
        LIMIT ${SEARCH_LIMIT}`,
      params,
    )

    return {
      rows: rows.map((r) => ({
        id: r.id,
        contactName: r.contact_name,
        contactHandle: r.contact_handle,
        contactUsername: r.contact_username,
        channelType: r.channel_type,
        channelName: r.channel_name,
        managerId: r.manager_id,
        managerName: r.manager_name,
        curatorName: r.curator_name,
        lastMessage: r.last_message,
        lastMessageAt: r.last_message_at,
        createdAt: r.created_at,
        unread: r.unread,
        status: r.status,
        godSynthetic: r.god_synthetic,
        isSimulated: r.is_simulated,
        messageCount: r.message_count,
      })),
      total,
      limit: SEARCH_LIMIT,
    }
  } catch (err) {
    // Never let this bubble to an opaque 500: surface the real reason so the
    // operator can see it (missing column after a skipped migration, DB
    // connectivity, etc.) instead of a blank "no results".
    const message = err instanceof Error ? err.message : String(err)
    const code =
      typeof (err as { code?: unknown })?.code === 'string'
        ? (err as { code: string }).code
        : undefined
    console.error('[v0] secretSearchConversationsAction failed:', code, message)
    return {
      rows: [],
      total: 0,
      limit: SEARCH_LIMIT,
      error:
        code === '42703'
          ? `В базе нет ожидаемого столбца (${message}). Похоже, не применена одна из миграций — выполните pnpm db:migrate на этой БД.`
          : `Ошибка поиска: ${message}`,
    }
  }
}

export interface HardDeleteResult extends ActionResult {
  /** Ids actually removed — lets the client prune its list optimistically. */
  deletedIds?: string[]
}

/**
 * PERMANENTLY delete conversations by id. This is irreversible: the row and all
 * of its cascade-linked data (messages, reads, transfers, autopilot, ai memory,
 * lead cards' link, …) are gone. Telemost meetings keep their history with a
 * NULLed conversation_id (ON DELETE SET NULL). Writes one audit row per call
 * with the full id list for forensics.
 */
export async function secretHardDeleteConversationsAction(input: {
  conversationIds: string[]
}): Promise<HardDeleteResult> {
  const admin = await requireAdmin()
  const ids = Array.from(new Set((input.conversationIds ?? []).filter(Boolean)))
  if (ids.length === 0)
    return { ok: false, message: 'Не выбрано ни одного диалога' }
  if (ids.length > 500)
    return { ok: false, message: 'За один раз можно удалить не более 500 диалогов' }

  let deletedIds: string[]
  try {
    // Snapshot a little context BEFORE deletion so the audit trail is meaningful
    // even though the rows themselves are about to vanish forever.
    const snapshot = await query<{
      id: string
      contact_name: string
      contact_handle: string
      channel_type: string
      manager_name: string | null
    }>(
      `SELECT c.id, c.contact_name, c.contact_handle, c.channel_type, mgr.name AS manager_name
         FROM conversations c
         LEFT JOIN managers mgr ON mgr.id = c.manager_id
        WHERE c.id = ANY($1::uuid[])`,
      [ids],
    )

    const deleted = await query<{ id: string }>(
      'DELETE FROM conversations WHERE id = ANY($1::uuid[]) RETURNING id',
      [ids],
    )
    deletedIds = deleted.map((r) => r.id)

    audit(admin, 'conversation.hard_delete', {
      summary: `Навсегда удалено диалогов: ${deletedIds.length}`,
      detail: {
        requested: ids.length,
        deleted: deletedIds.length,
        conversations: snapshot.map((s) => ({
          id: s.id,
          contact: s.contact_name,
          handle: s.contact_handle,
          channel: s.channel_type,
          manager: s.manager_name,
        })),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[v0] secretHardDeleteConversationsAction failed:', message)
    return { ok: false, message: `Не удалось удалить: ${message}` }
  }

  revalidatePath(ADMIN_PATH)

  if (deletedIds.length === 0)
    return { ok: false, message: 'Диалоги не найдены (возможно, уже удалены)' }

  return {
    ok: true,
    message: `Навсегда удалено диалогов: ${deletedIds.length}`,
    deletedIds,
  }
}
