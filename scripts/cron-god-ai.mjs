#!/usr/bin/env node
// Self-hosted cron trigger for the god-messenger AI autopilot sweep.
//
// On a VPS there is no Vercel Cron, so we drive /api/cron/god-ai ourselves.
// Run on a modest schedule by pm2 (see the `omnidesk-cron-god-ai` app in
// ecosystem.config.js) or a plain crontab entry, e.g. every 5 minutes:
//
//   */5 * * * * cd /path/to/omnidesk && node --env-file=.env scripts/cron-god-ai.mjs
//
// The daily-slot dedup, the MSK work-window check, batch limits and the
// master on/off switch all live in the data layer / config, so calling this
// often is safe — it does nothing at all while the autopilot is disabled.
//
// It performs an authenticated local HTTP call against the running panel,
// reusing the exact same CRON_SECRET check the route already enforces.

import 'dotenv/config'

const secret = process.env.CRON_SECRET
if (!secret) {
  console.error('[cron-god-ai] CRON_SECRET is not set; skipping run')
  process.exit(0)
}
// The secret is sent verbatim as an HTTP Authorization header; header values
// must be ASCII (see cron-followup.mjs for the full rationale).
if (!/^[\x20-\x7E]+$/.test(secret)) {
  console.error(
    '[cron-god-ai] CRON_SECRET contains non-ASCII characters; ' +
      'regenerate it with `openssl rand -base64 32` (ASCII only)',
  )
  process.exit(1)
}

const base =
  process.env.CRON_TARGET_URL ??
  `http://127.0.0.1:${process.env.PORT ?? '3000'}`
const url = `${base.replace(/\/$/, '')}/api/cron/god-ai`

try {
  const res = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${secret}` },
  })
  const body = await res.text()
  if (!res.ok) {
    console.error(`[cron-god-ai] request failed: ${res.status} ${body}`)
    process.exit(1)
  }
  console.log(`[cron-god-ai] ok: ${body}`)
  process.exit(0)
} catch (error) {
  console.error('[cron-god-ai] request error:', error)
  process.exit(1)
}
