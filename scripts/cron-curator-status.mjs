#!/usr/bin/env node
// Self-hosted cron trigger for curator daily-status push reminders.
//
// Drives /api/cron/curator-status every 20 minutes (see the
// `omnidesk-cron-curator-status` app in ecosystem.config.js). Safe to run
// often: before the 10:00 MSK deadline the route is a no-op, and after it the
// push uses a collapse tag so repeats replace each other on the device.

import 'dotenv/config'

const secret = process.env.CRON_SECRET
if (!secret) {
  console.error('[cron-curator-status] CRON_SECRET is not set; skipping run')
  process.exit(0)
}
if (!/^[\x20-\x7E]+$/.test(secret)) {
  console.error(
    '[cron-curator-status] CRON_SECRET contains non-ASCII characters; ' +
      'regenerate it with `openssl rand -base64 32` (ASCII only)',
  )
  process.exit(1)
}

const base =
  process.env.CRON_TARGET_URL ??
  `http://127.0.0.1:${process.env.PORT ?? '3000'}`
const url = `${base.replace(/\/$/, '')}/api/cron/curator-status`

try {
  const res = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${secret}` },
  })
  const body = await res.text()
  if (!res.ok) {
    console.error(`[cron-curator-status] request failed: ${res.status} ${body}`)
    process.exit(1)
  }
  console.log(`[cron-curator-status] ok: ${body}`)
  process.exit(0)
} catch (error) {
  console.error('[cron-curator-status] request error:', error)
  process.exit(1)
}
