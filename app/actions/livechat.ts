'use server'

import { randomUUID } from 'crypto'
import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  createChannel,
  deleteChannelById,
  getLivechatGlobalDefaults,
  getManagerById,
  saveLivechatGlobalDefaults,
  updateLivechatAppearance,
  updateLivechatPool,
  updateLivechatWidgetConfig,
} from '@/lib/data'
import {
  resolveGlobalDefaults,
  resolveWidgetConfig,
} from '@/lib/widget-config'

export interface LivechatResult {
  ok: boolean
  message: string
  apiKey?: string
}

/**
 * Admin: create a live-chat integration and assign it to a manager. We mint the
 * API key here; the manager simply receives the resulting conversations in
 * their inbox. The widget authenticates against POST /api/livechat/ingest
 * (inbound) and the GET /api/livechat/stream SSE endpoint (outbound replies).
 */
export async function createLivechatAction(
  formData: FormData,
): Promise<LivechatResult> {
  await requireAdmin()
  const name = String(formData.get('name') ?? '').trim() || 'Live chat'
  const domain = String(formData.get('domain') ?? '').trim()
  // Pool of managers that share this site's chats (round-robin distribution).
  // Accept a comma-separated list; fall back to the legacy single managerId.
  const rawIds =
    String(formData.get('managerIds') ?? '') ||
    String(formData.get('managerId') ?? '')
  const managerIds = Array.from(
    new Set(
      rawIds
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  )

  // Domain is optional now — the API key is the access boundary, so the widget
  // works on any origin. The field is kept purely as a label.
  if (managerIds.length === 0) {
    return { ok: false, message: 'Choose at least one manager for the queue.' }
  }
  // Validate every manager in the pool exists.
  for (const id of managerIds) {
    const manager = await getManagerById(id)
    if (!manager) {
      return { ok: false, message: 'One of the selected managers was not found.' }
    }
  }

  const apiKey = `lc_${randomUUID().replace(/-/g, '')}`
  await createChannel({
    // First manager is the channel owner; the full list is the round-robin pool.
    managerId: managerIds[0],
    type: 'livechat',
    name,
    detail: domain.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    status: 'pending',
    config: { domain, apiKey, pool: managerIds, rrCursor: 0 },
  })
  revalidatePath('/admin/livechat')
  return {
    ok: true,
    message: 'Live-chat integration created. Install the snippet to go live.',
    apiKey,
  }
}

/** Admin: update the manager queue (round-robin pool) for a live-chat channel. */
export async function updateLivechatPoolAction(
  channelId: string,
  managerIds: string[],
): Promise<LivechatResult> {
  await requireAdmin()
  const unique = Array.from(
    new Set(managerIds.map((v) => String(v ?? '').trim()).filter(Boolean)),
  )
  if (unique.length === 0) {
    return { ok: false, message: 'Choose at least one manager for the queue.' }
  }
  for (const id of unique) {
    const manager = await getManagerById(id)
    if (!manager) {
      return { ok: false, message: 'One of the selected managers was not found.' }
    }
  }
  await updateLivechatPool(channelId, unique)
  revalidatePath('/admin/livechat')
  return { ok: true, message: 'Manager queue updated.' }
}

/** Admin: update the widget appearance (title, color, greeting). */
export async function updateLivechatAppearanceAction(
  channelId: string,
  input: { title: string; color: string; greeting: string },
): Promise<LivechatResult> {
  await requireAdmin()
  const title = String(input.title ?? '').trim().slice(0, 80)
  const greeting = String(input.greeting ?? '').trim().slice(0, 120)
  const color = String(input.color ?? '').trim()
  // Only accept a valid hex color; otherwise fall back to the widget default.
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) {
    return { ok: false, message: 'Use a valid hex color, e.g. #2563eb.' }
  }
  await updateLivechatAppearance(channelId, { title, color, greeting })
  revalidatePath('/admin/livechat')
  return { ok: true, message: 'Widget appearance saved.' }
}

export async function deleteLivechatAction(
  id: string,
): Promise<LivechatResult> {
  await requireAdmin()
  await deleteChannelById(id)
  revalidatePath('/admin/livechat')
  return { ok: true, message: 'Live-chat integration removed.' }
}

/**
 * Admin: persist the full per-site widget config from the visual editor. The
 * raw input is re-validated/sanitised through resolveWidgetConfig (seeded with
 * the admin-wide defaults) before it is stored, so malformed values can never
 * reach the live site.
 */
export async function updateLivechatWidgetConfigAction(
  channelId: string,
  rawConfig: unknown,
): Promise<LivechatResult> {
  await requireAdmin()
  if (!channelId) return { ok: false, message: 'Channel not found.' }
  const globals = await getLivechatGlobalDefaults()
  const config = resolveWidgetConfig(rawConfig, globals)
  await updateLivechatWidgetConfig(channelId, config)
  revalidatePath('/admin/livechat')
  revalidatePath(`/admin/livechat/${channelId}`)
  return { ok: true, message: 'Настройки виджета сохранены.' }
}

/**
 * Admin: persist the admin-wide widget defaults (default working hours and
 * fallback messengers) used as the seed for every site that has not overridden
 * them. Re-validated through resolveGlobalDefaults before storage.
 */
export async function updateLivechatGlobalDefaultsAction(
  rawConfig: unknown,
): Promise<LivechatResult> {
  await requireAdmin()
  const defaults = resolveGlobalDefaults(rawConfig)
  await saveLivechatGlobalDefaults(defaults)
  revalidatePath('/admin/livechat')
  return { ok: true, message: 'Глобальные настройки по умолчанию сохранены.' }
}
