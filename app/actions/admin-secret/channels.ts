'use server'

import {
  revalidatePath,
} from 'next/cache'
import {
  requireAdmin,
} from '@/lib/auth'
import {
  query,
} from '@/lib/db'
import {
  createChannel,
  deleteChannelById,
  reassignChannelManager,
} from '@/lib/data'
import {
  type ChannelType,
} from '@/lib/types'
import {
  ADMIN_PATH,
  CHANNEL_TYPES,
  audit,
  type ActionResult,
} from './shared'

export async function secretCreateChannelAction(input: {
  name: string
  type: string
  managerId: string
  phone?: string
  token?: string
  groupId?: string
}): Promise<ActionResult> {
  await requireAdmin()

  const name = input.name?.trim()
  const type = input.type as ChannelType
  if (!name) return { ok: false, message: 'Укажите название канала' }
  if (!CHANNEL_TYPES.includes(type))
    return { ok: false, message: 'Неизвестный тип канала' }
  if (!input.managerId)
    return { ok: false, message: 'Выберите менеджера-владельца' }

  const config: Record<string, unknown> = {}
  if (input.token) config.token = input.token.trim()
  if (input.groupId) config.groupId = input.groupId.trim()
  if (type === 'whatsapp' && input.phone)
    config.phoneNumberId = input.phone.trim()

  try {
    await createChannel({
      managerId: input.managerId,
      type,
      name,
      detail: input.phone?.trim() || `${type} канал`,
      status: 'connected',
      sessionStatus: 'online',
      phone: type === 'telegram' || type === 'whatsapp' ? input.phone ?? null : null,
      config,
    })
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Не удалось создать канал',
    }
  }

  revalidatePath(ADMIN_PATH)
  return { ok: true, message: `Канал «${name}» создан` }
}

export async function secretDeleteChannelAction(
  id: string,
): Promise<ActionResult> {
  const admin = await requireAdmin()
  if (!id) return { ok: false, message: 'Не указан канал' }
  await deleteChannelById(id)
  audit(admin, 'channel.delete', { targetId: id })
  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Канал удалён' }
}

/** Admin: reassign a channel to another manager (or unassign with an empty id). */
export async function secretReassignChannelAction(
  id: string,
  managerId: string,
): Promise<ActionResult> {
  const admin = await requireAdmin()
  if (!id) return { ok: false, message: 'Не указан канал' }
  const next =
    managerId && managerId.trim() && managerId !== 'none'
      ? managerId.trim()
      : null
  await reassignChannelManager(id, next)
  audit(admin, 'channel.reassign', { targetId: id, detail: { managerId: next } })
  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: next ? 'Канал переназначен' : 'Владелец снят',
  }
}

export async function secretSetChannelStatusAction(
  id: string,
  status: string,
): Promise<ActionResult> {
  await requireAdmin()
  const allowed = ['connected', 'pending', 'error', 'disconnected']
  if (!id || !allowed.includes(status))
    return { ok: false, message: 'Некорректный статус' }
  await query(
    'UPDATE channels SET status = $2, last_checked_at = now() WHERE id = $1',
    [id, status],
  )
  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Статус канала обновлён' }
}

export async function secretToggleChannelIngestAction(
  id: string,
): Promise<ActionResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Не указан канал' }
  const rows = await query<{ ingest_paused: boolean }>(
    'UPDATE channels SET ingest_paused = NOT ingest_paused WHERE id = $1 RETURNING ingest_paused',
    [id],
  )
  if (!rows[0]) return { ok: false, message: 'Канал не найден' }
  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: rows[0].ingest_paused
      ? 'Приём сообщений приостановлен'
      : 'Приём сообщений возобновлён',
  }
}
