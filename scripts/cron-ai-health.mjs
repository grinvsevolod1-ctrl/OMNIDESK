#!/usr/bin/env node
// Self-hosted cron trigger for the AI-manager health watchdog.
//
// Drives /api/cron/ai-health every 10 minutes (see the
// `omnidesk-cron-ai-health` app in ecosystem.config.js). Safe to run often:
// below the error threshold the route is a no-op, and alerts carry a
// cooldown so repeats are suppressed instead of piling up.

import 'dotenv/config'

const secret = process.env.CRON_SECRET
if (!secret) {
  console.error('[cron-ai-health] CRON_SECRET is not set; skipping run')
  process.exit(0)
}
if (!/^[\x20-\x7E]+$/.test(secret)) {
  console.error(
    '[cron-ai-health] CRON_SECRET contains non-ASCII characters; ' +
      'regenerate it with `openssl rand -base64 32` (ASCII only)',
  )
  process.exit(1)
}

const base =
  process.env.CRON_TARGET_URL ??
  `http://127.0.0.1:${process.env.PORT ?? '3000'}`
const url = `${base.replace(/\/$/, '')}/api/cron/ai-health`

try {
  const res = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${secret}` },
  })
  const body = await res.text()
  if (!res.ok) {
    console.error(`[cron-ai-health] request failed: ${res.status} ${body}`)
    process.exit(1)
  }
  console.log(`[cron-ai-health] ok: ${body}`)
  process.exit(0)
} catch (err) {
  console.error('[cron-ai-health] request threw:', err)
  process.exit(1)
}
