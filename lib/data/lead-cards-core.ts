/**
 * Ядро домена карточек лидов: типы, конвертеры строк БД и общий SELECT.
 * Вынесено из lead-cards.ts, чтобы админская выборка (lead-admin.ts) и
 * основной модуль не образовывали циклический импорт.
 */
import { isLeadStatus, type LeadStatus } from '../lead-status'

export interface LeadCard {
  id: string
  conversationId: string | null
  managerId: string | null
  managerName: string | null
  curatorId: string | null
  curatorName: string | null
  curatorCity: string | null
  fullName: string
  phone: string
  telegramUsername: string
  /** Числовой Telegram ID контакта — отдельно от телефона (миграция 130). */
  telegramId: string
  city: string
  /** Регион РФ по справочнику (заполняется в админской выборке). */
  region?: string | null
  address: string
  vacancy: string
  status: LeadStatus | null
  previousStatus: LeadStatus | null
  statusConfirmedAt: string | null
  /** YYYY-MM-DD in MSK when the current status was confirmed. */
  statusConfirmedDate: string | null
  transferredAt: string | null
  /** Set when the lead left the active workspace (final status, migration 117). */
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface LeadCardComment {
  id: string
  leadCardId: string
  authorId: string | null
  authorName: string | null
  body: string
  status: LeadStatus | null
  createdAt: string
  /** Когда комментарий последний раз правили (миграция 142); null — не правили. */
  editedAt: string | null
  /** Прошлые версии текста, новые сверху. Заполняется только при editedAt. */
  revisions: LeadCommentRevision[]
}

/** Прошлая версия текста комментария (до очередной правки). */
export interface LeadCommentRevision {
  id: string
  /** Текст, каким он был ДО правки. */
  previousBody: string
  editedByName: string | null
  editedAt: string
}

export interface LeadTransfer {
  id: string
  leadCardId: string
  fromCuratorName: string | null
  toCuratorName: string | null
  initiatedByRole: string
  createdAt: string
}

export interface LeadCardRow {
  id: string
  conversation_id: string | null
  manager_id: string | null
  manager_name: string | null
  curator_id: string | null
  curator_name: string | null
  curator_city: string | null
  full_name: string
  phone: string
  telegram_username: string
  telegram_id: string
  city: string
  address: string
  vacancy: string
  status: string | null
  previous_status: string | null
  status_confirmed_at: string | Date | null
  status_confirmed_date: string | Date | null
  transferred_at: string | Date | null
  archived_at: string | Date | null
  created_at: string | Date
  updated_at: string | Date
}

export interface CommentRow {
  id: string
  lead_card_id: string
  author_id: string | null
  author_name: string | null
  body: string
  status: string | null
  created_at: string | Date
  edited_at?: string | Date | null
}

export function toDateOnly(v: string | Date | null | undefined): string | null {
  if (!v) return null
  if (typeof v === 'string') {
    // Postgres date may arrive as 'YYYY-MM-DD' or ISO timestamp.
    return v.slice(0, 10)
  }
  // node-postgres parses a DATE column into a JS Date at SERVER-LOCAL
  // midnight. Converting through toISOString() (UTC) shifts the value back
  // one day whenever the server timezone is ahead of UTC (e.g. a VPS running
  // in MSK): «2026-08-07 00:00 MSK» -> «2026-08-06T21:00Z» -> "2026-08-06".
  // That off-by-one made leadNeedsDailyStatus() treat a just-confirmed status
  // as yesterday's, keeping the curator workspace locked. Read the LOCAL
  // calendar components instead — they match the stored date exactly.
  const y = v.getFullYear()
  const m = String(v.getMonth() + 1).padStart(2, '0')
  const d = String(v.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function toLeadCard(r: LeadCardRow): LeadCard {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    managerId: r.manager_id,
    managerName: r.manager_name,
    curatorId: r.curator_id,
    curatorName: r.curator_name,
    curatorCity: r.curator_city,
    fullName: r.full_name ?? '',
    phone: r.phone ?? '',
    telegramUsername: r.telegram_username ?? '',
    telegramId: r.telegram_id ?? '',
    city: r.city ?? '',
    address: r.address ?? '',
    vacancy: r.vacancy ?? '',
    status: isLeadStatus(r.status) ? r.status : null,
    previousStatus: isLeadStatus(r.previous_status) ? r.previous_status : null,
    statusConfirmedAt: r.status_confirmed_at
      ? new Date(r.status_confirmed_at).toISOString()
      : null,
    statusConfirmedDate: toDateOnly(r.status_confirmed_date),
    transferredAt: r.transferred_at
      ? new Date(r.transferred_at).toISOString()
      : null,
    archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }
}

export function toComment(r: CommentRow): LeadCardComment {
  return {
    id: r.id,
    leadCardId: r.lead_card_id,
    authorId: r.author_id,
    authorName: r.author_name,
    body: r.body,
    status: isLeadStatus(r.status) ? r.status : null,
    createdAt: new Date(r.created_at).toISOString(),
    editedAt: r.edited_at ? new Date(r.edited_at).toISOString() : null,
    // Ревизии подгружаются отдельным запросом в listLeadComments.
    revisions: [],
  }
}

export const CARD_SELECT = `
  lc.id, lc.conversation_id, lc.manager_id, lc.curator_id,
  lc.full_name, lc.phone, lc.telegram_username, lc.telegram_id, lc.city, lc.address, lc.vacancy,
  lc.status, lc.previous_status, lc.status_confirmed_at, lc.status_confirmed_date,
  lc.transferred_at, lc.archived_at, lc.created_at, lc.updated_at,
  m.name AS manager_name,
  c.name AS curator_name,
  c.city AS curator_city
`
