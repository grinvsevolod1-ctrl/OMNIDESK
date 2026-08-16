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

// Load .env from the repo root so this works when launched by pm2 (which does
// NOT pass --env-file). `dotenv` is a root dependency; the import is a no-op if
// the vars are already present (e.g. when started with `node --env-file=.env`).
import 'dotenv/config'

const secret = process.env.CRON_SECRET
if (!secret) {
  console.error('[cron-sync-ads] CRON_SECRET is not set; skipping run')
  process.exit(0)
}
// The secret is sent verbatim as an HTTP Authorization header. Header values
// must be ISO-8859-1 / ASCII; a stray non-ASCII char (e.g. a Cyrillic letter
// pasted into .env) would otherwise make fetch throw a cryptic
// "Cannot convert argument to a ByteString" error. Fail with a clear message.
if (!/^[\x20-\x7E]+$/.test(secret)) {
  console.error(
    '[cron-sync-ads] CRON_SECRET contains non-ASCII characters; ' +
      'regenerate it with `openssl rand -base64 32` (ASCII only)',
  )
  process.exit(1)
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
