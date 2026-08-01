'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { setFake502 } from '@/lib/data'
import { ADMIN_PATH, audit, type ActionResult } from './shared'

/**
 * Toggle the fake "502 Bad Gateway" screen shown to admins & managers. Only the
 * god panel calls this; the panel route itself is never gated by the flag, so a
 * super-admin can always turn it back off. Every flip is written to the audit
 * trail.
 */
export async function secretSetFake502Action(
  enabled: boolean,
): Promise<ActionResult> {
  const admin = await requireAdmin()

  await setFake502(enabled)
  audit(admin, enabled ? 'maintenance.fake502.on' : 'maintenance.fake502.off', {
    summary: enabled
      ? 'Включён экран 502 для админов и менеджеров'
      : 'Экран 502 выключен',
  })

  // Refresh the god panel plus the two gated dashboards so the change takes
  // effect immediately without waiting for their own revalidation.
  revalidatePath(ADMIN_PATH)
  revalidatePath('/admin', 'layout')
  revalidatePath('/app', 'layout')

  return {
    ok: true,
    message: enabled
      ? 'Экран «502 Bad Gateway» включён'
      : 'Экран «502 Bad Gateway» выключен',
  }
}
