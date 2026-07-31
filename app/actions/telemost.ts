'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  getTelemostConfig,
  saveTelemostConfig,
  type TelemostConfig,
} from '@/lib/data'
import { createTelemostMeeting } from '@/lib/telemost'

export interface TelemostResult {
  ok: boolean
  message: string
}

type WaitingRoomLevel = TelemostConfig['waitingRoomLevel']

const LEVELS: WaitingRoomLevel[] = ['PUBLIC', 'ORGANIZATION', 'ADMINISTRATOR']

/**
 * Admin: save Telemost settings. A blank token keeps the existing one, so the
 * admin can flip `enabled` or change the waiting-room level without re-typing
 * the secret.
 */
export async function saveTelemostConfigAction(input: {
  token: string
  waitingRoomLevel: string
  enabled: boolean
}): Promise<TelemostResult> {
  await requireAdmin()

  const level = LEVELS.includes(input.waitingRoomLevel as WaitingRoomLevel)
    ? (input.waitingRoomLevel as WaitingRoomLevel)
    : 'PUBLIC'

  await saveTelemostConfig({
    token: input.token,
    waitingRoomLevel: level,
    enabled: input.enabled,
  })

  revalidatePath('/admin/telemost')
  revalidatePath('/app/meetings')
  revalidatePath('/app/inbox')
  return { ok: true, message: 'Настройки Яндекс Телемост сохранены.' }
}

/** Admin: remove the saved token entirely (disconnect). */
export async function clearTelemostTokenAction(): Promise<TelemostResult> {
  await requireAdmin()
  await saveTelemostConfig({
    waitingRoomLevel: 'PUBLIC',
    enabled: false,
    clearToken: true,
  })
  revalidatePath('/admin/telemost')
  revalidatePath('/app/meetings')
  revalidatePath('/app/inbox')
  return { ok: true, message: 'Токен Телемост удалён.' }
}

/**
 * Admin: verify the saved token actually works by creating a throwaway test
 * meeting against the Yandex API. Surfaces scope/expiry problems before a
 * manager hits them.
 */
export async function checkTelemostTokenAction(): Promise<TelemostResult> {
  await requireAdmin()

  const cfg = await getTelemostConfig()
  if (!cfg?.token) {
    return { ok: false, message: 'Токен не сохранён. Сначала сохраните настройки.' }
  }

  const res = await createTelemostMeeting()
  if (!res.ok) {
    return { ok: false, message: res.message }
  }
  return {
    ok: true,
    message: 'Токен действителен — тестовая встреча успешно создана.',
  }
}
