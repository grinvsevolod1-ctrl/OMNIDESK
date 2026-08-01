import { requireAdmin } from '@/lib/auth'
import { recordAdminAction } from '@/lib/data'
import { isMessengerUnlocked } from '@/lib/messenger-gate'
import type { ChannelType, Message, SessionUser } from '@/lib/types'

/**
 * Access guard for the actions shared between the god console and the standalone
 * messenger. It grants access via EITHER factor:
 *
 *  1. the messenger passcode cookie (the phone PWA opens with no admin login), or
 *  2. an authenticated admin session (the god console path — the page itself
 *     already enforces the god passcode unlock on top).
 *
 * The messenger cookie is checked FIRST so a messenger-only visitor never hits
 * `requireAdmin()` (which would redirect a non-admin away).
 */
export async function assertConsoleOrMessenger(): Promise<void> {
  if (await isMessengerUnlocked()) return
  await requireAdmin()
}

/**
 * Shared, non-action helpers for the God-mode admin console server actions.
 *
 * This module deliberately does NOT carry the `'use server'` directive: the
 * per-domain action files (channels/conversations/managers/ads) are the
 * `'use server'` boundaries, and they import these plain helpers. Keeping
 * the shared constants + audit helper here lets each action group stay small and
 * focused while still funneling every privileged mutation through one audit
 * trail and one canonical admin path.
 */

/** Path of the God panel; every action revalidates it after a mutation. */
export const ADMIN_PATH = '/wijegniwjgwjog'

/** Standard result envelope returned by mutating God-panel actions. */
export interface ActionResult {
  ok: boolean
  message: string
}

/** Result of an action that writes a message, exposing the created row. */
export interface SendResult extends ActionResult {
  createdMessage: Message | null
  /**
   * True when this manual message caused the simulator to detach from THIS
   * dialogue (it was actively driving it and is now paused). Lets the console
   * surface a one-off "you've stepped in" toast without a refetch.
   */
  simDetached?: boolean
}

/** Record a privileged God-panel action to the audit trail (best-effort). */
export function audit(
  admin: SessionUser,
  action: string,
  opts?: {
    targetId?: string | null
    summary?: string
    detail?: Record<string, unknown>
  },
): void {
  void recordAdminAction({
    actor: { id: admin.sub, name: admin.name || admin.email },
    action,
    targetId: opts?.targetId ?? null,
    summary: opts?.summary,
    detail: opts?.detail,
  })
}

/** Channel types selectable when creating a channel in the panel. */
export const CHANNEL_TYPES: ChannelType[] = [
  'telegram',
  'whatsapp',
  'vk',
  'max',
  'livechat',
]

/** Conversation lead-statuses selectable in the panel. */
export const CONVERSATION_STATUSES = [
  'liquid',
  'not_liquid',
  'unsubscribed',
  'transferred',
] as const
