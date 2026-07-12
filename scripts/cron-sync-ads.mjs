#!/usr/bin/env node
// Self-hosted cron trigger for the ad-sync endpoint.
//
// On a VPS there is no Vercel Cron, so we drive /api/cron/sync-ads ourselves.
// This script is run on a schedule by pm2 (see the `omnidesk-cron-sync-ads`
// app in ecosystem.config.js) or by a plain crontab entry, e.g.:
//
//   0 */6 * * * cd /path/to/omnidesk && node --env-file=.env scripts/cron-sync-ads.mjs
//
// It simply performs an authenticated local HTTP call against the running
// panel, reusing the exact same CRON_SECRET check the route already enforces.

const secret = process.env.CRON_SECRET
if (!secret) {
  console.error('[cron-sync-ads] CRON_SECRET is not set; skipping run')
  process.exit(0)
}

// Default to the local panel; override with CRON_TARGET_URL if the panel
// listens on a different host/port.
const base =
  process.env.CRON_TARGET_URL ??
  `http://127.0.0.1:${process.env.PORT ?? '3000'}`
const url = `${base.replace(/\/$/, '')}/api/cron/sync-ads`

try {
  const res = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${secret}` },
  })
  const body = await res.text()
  if (!res.ok) {
    console.error(`[cron-sync-ads] request failed: ${res.status} ${body}`)
    process.exit(1)
  }
  console.log(`[cron-sync-ads] ok: ${body}`)
  process.exit(0)
} catch (error) {
  console.error('[cron-sync-ads] request error:', error)
  process.exit(1)
}
