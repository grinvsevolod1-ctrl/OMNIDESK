/* --------------------------------------------------------------------------
 * Worker repository barrel.
 *
 * The data layer is split into focused domain modules; every consumer keeps
 * importing them via `repo.*` (import * as repo from './repo.js'), so the
 * split is invisible at call sites:
 *
 *   repo-jobs.ts            channel_jobs: claim/reschedule/recover/purge/finish
 *   repo-channels.ts        channels + session status + channel_secrets
 *   repo-proxies.ts         proxies: lookup, health marking, failover picking
 *   repo-telegram-cache.ts  telegram_peers + backfill watermarks
 *   repo-media.ts           message media
 *   repo-messages.ts        messages + conversations
 *   repo-ai.ts              AI/autopilot barrel (see its header)
 * ------------------------------------------------------------------------ */
export * from './repo-jobs.js'
export * from './repo-channels.js'
export * from './repo-proxies.js'
export * from './repo-telegram-cache.js'
export * from './repo-media.js'
export * from './repo-messages.js'
export * from './repo-ai.js'
