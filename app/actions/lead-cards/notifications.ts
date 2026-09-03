'use server'

/**
 * In-app notices for curators (migration 149). The curator overview polls
 * unseen notices and shows a modal (e.g. «лид возвращён из архива» с причиной),
 * then marks each one seen. Scoped to the current curator on the server.
 */
import { requireCurator } from '@/lib/auth'
import {
  listUnseenNotifications,
  markNotificationSeen,
  type LeadNotification,
} from '@/lib/data/lead-notifications'

/** Curator: unseen in-app notices for the current curator. */
export async function listMyNoticesAction(): Promise<LeadNotification[]> {
  const session = await requireCurator()
  return listUnseenNotifications(session.sub)
}

/** Curator: dismiss one notice (scoped to the current curator — IDOR guard). */
export async function markNoticeSeenAction(
  id: string,
): Promise<{ ok: boolean }> {
  const session = await requireCurator()
  const ok = await markNotificationSeen(id, session.sub)
  return { ok }
}
