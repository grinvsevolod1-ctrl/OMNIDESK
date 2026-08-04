#!/usr/bin/env node
// Self-hosted cron trigger for the OS shell scheduled-commands sweep.
//
// Drives /api/cron/console-schedules on a schedule via pm2 (see the
// `omnidesk-cron-console-schedules` app in ecosystem.config.js) or crontab:
//
//   */5 * * * * cd /path/to/omnidesk && node --env-file=.env scripts/cron-console-schedules.mjs
//
// Claiming is atomic in the data layer (FOR UPDATE SKIP LOCKED), so frequent /
// overlapping calls are safe — each due schedule runs exactly once.

import 'dotenv/config'

const secret = process.env.CRON_SECRET
if (!secret) {
  console.error('[cron-console-schedules] CRON_SECRET is not set; skipping run')
  process.exit(0)
}
if (!/^[\x20-\x7E]+$/.test(secret)) {
  console.error(
    '[cron-console-schedules] CRON_SECRET contains non-ASCII characters; ' +
      'regenerate it with `openssl rand -base64 32` (ASCII only)',
  )
  process.exit(1)
}

const base =
  process.env.CRON_TARGET_URL ??
  `http://127.0.0.1:${process.env.PORT ?? '3000'}`
const url = `${base.replace(/\/$/, '')}/api/cron/console-schedules`

try {
  const res = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${secret}` },
  })
  const body = await res.text()
  if (!res.ok) {
    console.error(`[cron-console-schedules] request failed: ${res.status} ${body}`)
    process.exit(1)
  }
  console.log(`[cron-console-schedules] ok: ${body}`)
  process.exit(0)
} catch (error) {
  console.error('[cron-console-schedules] request error:', error)
  process.exit(1)
}
