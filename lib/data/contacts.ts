/**
 * Admin-only contacts / leads database. Surfaces the raw contact identifiers
 * (handle, username) that the manager inbox deliberately hides, grouped by
 * channel for the «Контакты» admin tab. Admin-wide: spans every manager.
 */
import { query } from '../db'
import {
  getChannelMeta,
  type ChannelType,
  type ContactChannelGroup,
  type ContactRecord,
  type LeadStatus,
} from '../types'
import { effectiveStatusSql } from './shared'

interface ContactRow {
  id: string
  channel_type: ChannelType
  channel_name: string | null
  contact_name: string
  contact_handle: string
  contact_username: string | null
  manager_name: string | null
  status: LeadStatus
  created_at: string | Date
  last_message_at: string | Date
}

/** Channel display order for the tab cards (known channels first). */
const CHANNEL_ORDER: ChannelType[] = [
  'telegram',
  'whatsapp',
  'vk',
  'max',
  'livechat',
]

function toContact(r: ContactRow): ContactRecord {
  return {
    id: r.id,
    channelType: r.channel_type,
    channelName: r.channel_name,
    contactName: r.contact_name,
    contactHandle: r.contact_handle,
    contactUsername: r.contact_username ?? null,
    managerName: r.manager_name,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    lastMessageAt: new Date(r.last_message_at).toISOString(),
  }
}

/**
 * List every contact across all channels, grouped by channel type. Ordered by
 * most recent activity within each group. One query + in-memory grouping keeps
 * this simple; the contacts table is admin-facing and not hot-path.
 *
 * `channelIds` — опциональный фильтр для drill-down «контакты одного
 * источника» (Обзор → детали → лиды): показываются только диалоги
 * перечисленных каналов.
 */
export async function listContactsByChannel(
  channelIds?: string[],
): Promise<ContactChannelGroup[]> {
  const filter =
    channelIds && channelIds.length > 0 ? `WHERE c.channel_id = ANY($1)` : ''
  const rows = await query<ContactRow>(
    `SELECT c.id,
            c.channel_type,
            ch.name              AS channel_name,
            c.contact_name,
            c.contact_handle,
            c.contact_username,
            m.name               AS manager_name,
            ${effectiveStatusSql('c')} AS status,
            c.created_at,
            c.last_message_at
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
       LEFT JOIN managers m ON m.id = c.manager_id
       ${filter}
      ORDER BY c.last_message_at DESC`,
    filter ? [channelIds] : [],
  )

  const byType = new Map<ChannelType, ContactRecord[]>()
  for (const row of rows) {
    const contact = toContact(row)
    const list = byType.get(contact.channelType)
    if (list) list.push(contact)
    else byType.set(contact.channelType, [contact])
  }

  // Emit known channels in a stable order first, then any unknown types.
  const seen = new Set<ChannelType>()
  const groups: ContactChannelGroup[] = []
  const pushGroup = (type: ChannelType) => {
    if (seen.has(type)) return
    seen.add(type)
    const contacts = byType.get(type) ?? []
    groups.push({
      channelType: type,
      // Безопасный доступ: тип вне панельного набора (legacy/bad rows)
      // получает читаемый fallback-лейбл вместо undefined-краша.
      label: getChannelMeta(type).label || type,
      count: contacts.length,
      contacts,
    })
  }
  for (const type of CHANNEL_ORDER) pushGroup(type)
  for (const type of byType.keys()) pushGroup(type)

  // В режиме фильтра по источнику пустые типы каналов — шум: скрываем их.
  if (channelIds && channelIds.length > 0)
    return groups.filter((g) => g.count > 0)

  return groups
}
