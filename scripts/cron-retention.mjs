#!/usr/bin/env node
// Self-hosted cron trigger for the nightly data-retention sweep.
//
// Drives /api/cron/retention once a day (see the `omnidesk-cron-retention`
// app in ecosystem.config.js). The route deletes in bounded batches, so even
// a first run against a large backlog is safe — the backlog just drains over
// a few nights.

import 'dotenv/config'

const secret = process.env.CRON_SECRET
if (!secret) {
  console.error('[cron-retention] CRON_SECRET is not set; skipping run')
  process.exit(0)
}
if (!/^[\x20-\x7E]+$/.test(secret)) {
  console.error(
    '[cron-retention] CRON_SECRET contains non-ASCII characters; ' +
      'regenerate it with `openssl rand -base64 32` (ASCII only)',
  )
  process.exit(1)
}

const base =
  process.env.CRON_TARGET_URL ??
  `http://127.0.0.1:${process.env.PORT ?? '3000'}`
const url = `${base.replace(/\/$/, '')}/api/cron/retention`

try {
  const res = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${secret}` },
  })
  const body = await res.text()
  if (!res.ok) {
    console.error(`[cron-retention] request failed: ${res.status} ${body}`)
    process.exit(1)
  }
  console.log(`[cron-retention] ok: ${body}`)
  process.exit(0)
} catch (err) {
  console.error('[cron-retention] request threw:', err)
  process.exit(1)
}
