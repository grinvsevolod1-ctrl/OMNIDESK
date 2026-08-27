/**
 * God-mode admin console server actions (panel at /wijegniwjgwjog).
 *
 * This file is a thin re-export barrel: the actions themselves live in focused
 * per-domain `'use server'` modules under ./admin-secret/, and the shared
 * (non-action) helpers live in ./admin-secret/shared. Consumers keep importing
 * everything from '@/app/actions/admin-secret' exactly as before.
 *
 * Every underlying action re-checks `requireAdmin()` on the server — the page
 * guard is not enough on its own, because a server action is an independent POST
 * endpoint that an attacker could call directly. All mutations funnel through the
 * same parameterised `query`/`lib/data` helpers used everywhere else (no string
 * interpolation into SQL), and each revalidates the page so the RSC re-renders
 * with fresh data instead of relying on client-side cache juggling.
 */

export type { ActionResult } from './admin-secret/shared'

export * from './admin-secret/gate'
export * from './admin-secret/channels'
export * from './admin-secret/conversations'
export * from './admin-secret/managers'
export * from './admin-secret/conversation-edits'
export * from './admin-secret/ads'
export * from './admin-secret/telegram-security'
export * from './admin-secret/maintenance'
export * from './admin-secret/god-push'
export * from './admin-secret/sites'
export * from './admin-secret/gmt'
export * from './admin-secret/gmt-import'
export * from './admin-secret/ping'
export * from './admin-secret/autopilot'
