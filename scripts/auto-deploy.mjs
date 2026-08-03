#!/usr/bin/env node
/**
 * Auto-deploy watcher for self-hosted Omnidesk.
 *
 * Polls the remote deploy branch (default: main) and runs ./deploy.sh whenever a
 * new commit lands, so the VPS always tracks main automatically. Runs as a
 * long-lived PM2 process (omnidesk-auto-deploy) alongside the panel/worker/cron.
 *
 * Why polling instead of a GitHub webhook:
 *   - No inbound port / firewall rule / public HTTPS endpoint to expose and
 *     secure on the VPS.
 *   - The box already has a git remote with pull credentials, so nothing else is
 *     required — all git traffic is outbound.
 *
 * Config (all env vars optional):
 *   AUTO_DEPLOY_ENABLED     "false" to keep the process registered but idle.
 *   AUTO_DEPLOY_BRANCH      branch to track (default "main").
 *   AUTO_DEPLOY_REMOTE      git remote (default "origin").
 *   AUTO_DEPLOY_INTERVAL_MS poll interval in ms (default 30000, floor 5000).
 *   AUTO_DEPLOY_TIMEOUT_MS  hard cap for a single deploy.sh run (default 900000).
 *   APP_DIR                 repo checkout (default: repo root of this file).
 *   DEPLOY_TG_BOT_TOKEN     Telegram bot token for deploy notifications
 *                           (create a bot via @BotFather). Optional: without
 *                           it, notifications are silently skipped.
 *   DEPLOY_TG_CHAT_ID       chat id to notify (your own id — get it via
 *                           @userinfobot, or a group id). Required with token.
 *
 * Safety model:
 *   - deploy.sh is self-serializing via flock, so this watcher can never clobber
 *     a manual `./deploy.sh` running at the same moment (and vice-versa): the
 *     loser of the race exits cleanly and we simply retry next cycle.
 *   - Deploys run synchronously (spawnSync), so poll cycles never overlap.
 *   - Any error in a cycle is logged and the watcher keeps running — it must
 *     never crash-loop and stop tracking main.
 *   - This process is deliberately NOT in deploy.sh's `pm2 delete` list, so a
 *     deploy it triggers doesn't kill the process performing it. After a deploy,
 *     if this file itself changed, we exit(0) so PM2 relaunches the new version
 *     (self-updating watcher).
 */
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT =
  process.env.APP_DIR || path.resolve(path.dirname(__filename), '..')

const cfg = {
  enabled:
    (process.env.AUTO_DEPLOY_ENABLED ?? 'true').toLowerCase() !== 'false',
  branch: process.env.AUTO_DEPLOY_BRANCH || 'main',
  remote: process.env.AUTO_DEPLOY_REMOTE || 'origin',
  intervalMs: Math.max(5_000, intEnv('AUTO_DEPLOY_INTERVAL_MS', 30_000)),
  deployTimeoutMs: intEnv('AUTO_DEPLOY_TIMEOUT_MS', 900_000),
  tgToken: process.env.DEPLOY_TG_BOT_TOKEN || '',
  tgChatId: process.env.DEPLOY_TG_CHAT_ID || '',
}

// Full output of the most recent deploy.sh run (captured via tee so the
// realtime stream still reaches the PM2 log). Attached to failure notices.
const DEPLOY_LOG_FILE = path.join(REPO_ROOT, '.deploy.log')

function intEnv(name, fallback) {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

function log(...args) {
  console.log(`[auto-deploy] ${new Date().toISOString()}`, ...args)
}

function git(args, opts = {}) {
  const res = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env,
    timeout: opts.timeout || 120_000,
  })
  return {
    ok: res.status === 0,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
  }
}

function selfHash() {
  try {
    return crypto
      .createHash('sha1')
      .update(fs.readFileSync(__filename))
      .digest('hex')
  } catch {
    return ''
  }
}

const startHash = selfHash()
let deploying = false
// Commit sha whose deploy failure was already reported to Telegram — resets
// on any success so a NEW breakage on the next commit is reported again.
let failNotifiedSha = ''

// Exponential retry backoff for a commit that keeps failing to deploy.
// WHY: a deploy restarts the pm2 apps (including the Telegram worker, which
// force-reconnects every personal account) EARLY in the script, so retrying a
// persistently broken commit every 30s used to bounce the whole stack — and
// every Telegram session with it — in an endless loop. Retrying is still
// mandatory (a transient failure must self-heal), but repeated failures of
// the SAME sha back off: 1m, 2m, 4m, ... capped at 15m. Any new commit or a
// success resets the backoff instantly.
const FAIL_BACKOFF_BASE_MS = 60_000
const FAIL_BACKOFF_MAX_MS = 15 * 60_000
let failBackoff = { sha: '', failures: 0, notBefore: 0 }

function noteDeployFailure(sha) {
  if (failBackoff.sha !== sha) failBackoff = { sha, failures: 0, notBefore: 0 }
  failBackoff.failures += 1
  const delay = Math.min(
    FAIL_BACKOFF_MAX_MS,
    FAIL_BACKOFF_BASE_MS * 2 ** (failBackoff.failures - 1),
  )
  failBackoff.notBefore = Date.now() + delay
  log(
    `deploy of ${sha.slice(0, 8)} failed ${failBackoff.failures}x — ` +
      `next retry in ${Math.round(delay / 1000)}s.`,
  )
}

// Commit of the last deploy that finished END-TO-END. deploy.sh writes this
// marker as its very last step, past every failure point (build, swap, pm2
// restart). We compare origin/<branch> against THIS — never against `git
// rev-parse HEAD` — because deploy.sh hard-resets HEAD to the remote sha at the
// very START of a deploy. With the old HEAD comparison, a deploy killed
// mid-flight (e.g. by our own AUTO_DEPLOY_TIMEOUT_MS) left HEAD == remote, so
// the next tick concluded "already up to date" and never retried, leaving the
// panel down (nginx 502) until a human ran deploy.sh by hand.
const LAST_SUCCESS_FILE = path.join(REPO_ROOT, '.deploy.last-success')

function deployedSha() {
  try {
    const sha = fs.readFileSync(LAST_SUCCESS_FILE, 'utf8').trim()
    if (/^[0-9a-f]{40}$/.test(sha)) return sha
  } catch {
    // No marker yet (first run after this feature shipped, or a fresh box).
  }
  // Fallback: whatever is checked out. Correct for a box that was deployed
  // before the marker existed; a stale-but-equal HEAD just means one harmless
  // extra deploy at worst, never a skipped one.
  const r = git(['rev-parse', 'HEAD'])
  return r.ok ? r.stdout : ''
}

// Latest commit on the tracked remote branch (after a fetch).
function remoteSha() {
  const r = git(['rev-parse', `${cfg.remote}/${cfg.branch}`])
  return r.ok ? r.stdout : ''
}

// ── Telegram deploy notifications ─────────────────────────────────────────────
// Fire-and-forget by design: a Telegram outage must never fail or delay a
// deploy, so every network error here is logged and swallowed. Configured via
// DEPLOY_TG_BOT_TOKEN + DEPLOY_TG_CHAT_ID in the shared .env (ecosystem.config
// injects it into this process); with either missing we skip silently.

function tgConfigured() {
  return Boolean(cfg.tgToken && cfg.tgChatId)
}

async function tgSendMessage(text) {
  if (!tgConfigured()) return
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${cfg.tgToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: cfg.tgChatId,
          // Plain text on purpose: commit messages routinely contain _ * [ `
          // which break Markdown parse_mode and get the whole notice rejected.
          text: text.slice(0, 4000),
          disable_web_page_preview: true,
        }),
      },
    )
    if (!res.ok) log(`telegram sendMessage failed: HTTP ${res.status}`)
  } catch (err) {
    log('telegram sendMessage error:', err?.message || err)
  }
}

async function tgSendLogDocument(caption) {
  if (!tgConfigured()) return
  try {
    // Last ~300 lines are where the build/migrate error always is; full logs
    // of a long build can exceed Telegram's 50 MB document cap.
    let content = ''
    try {
      const lines = fs.readFileSync(DEPLOY_LOG_FILE, 'utf8').split('\n')
      content = lines.slice(-300).join('\n')
    } catch {
      content = 'deploy log file is missing — deploy.sh may have died before producing output.'
    }
    const form = new FormData()
    form.append('chat_id', cfg.tgChatId)
    form.append('caption', caption.slice(0, 1000))
    form.append(
      'document',
      new Blob([content], { type: 'text/plain' }),
      `deploy-error-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
    )
    const res = await fetch(
      `https://api.telegram.org/bot${cfg.tgToken}/sendDocument`,
      { method: 'POST', body: form },
    )
    if (!res.ok) log(`telegram sendDocument failed: HTTP ${res.status}`)
  } catch (err) {
    log('telegram sendDocument error:', err?.message || err)
  }
}

// One-line summary of a commit for the notification text.
function commitSummary(sha) {
  const r = git(['log', '-1', '--format=%h %s', sha])
  return r.ok ? r.stdout : sha.slice(0, 8)
}

function runDeploy() {
  log(`Change detected on ${cfg.remote}/${cfg.branch} — running deploy.sh ...`)
  // tee: the realtime stream still reaches the PM2 log (stdio inherit), while
  // the full output lands in .deploy.log for the failure notification.
  // pipefail keeps deploy.sh's exit code as the pipeline's exit code.
  const res = spawnSync(
    'bash',
    [
      '-c',
      `set -o pipefail; bash ${JSON.stringify(path.join(REPO_ROOT, 'deploy.sh'))} 2>&1 | tee ${JSON.stringify(DEPLOY_LOG_FILE)}`,
    ],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      // deploy.sh defaults to the checked-out branch; pin it to the tracked one.
      env: { ...process.env, DEPLOY_BRANCH: cfg.branch },
      timeout: cfg.deployTimeoutMs,
      // Own process GROUP/session. PM2 stops processes by signalling the whole
      // group (SIGINT first), so without this a `pm2 restart omnidesk-auto-
      // deploy` issued mid-deploy (e.g. to pick up new .env vars) killed the
      // in-flight deploy.sh with SIGINT → "exited with code 130". Detached, the
      // graceful group signal no longer reaches the deploy; the watcher itself
      // defers its own SIGINT handler until spawnSync returns, so the deploy
      // finishes and the marker file is written before the watcher exits.
      detached: true,
    },
  )
  if (res.status === 0) {
    // Exit 0 covers both "deployed" and "another deploy held the lock, skipped"
    // (deploy.sh exits 0 on lock contention). Either way we're not behind for a
    // bad reason; if we skipped, the marker file is unchanged so the next tick
    // still sees a mismatch and retries. A non-zero status / signal below is
    // therefore a genuine deploy failure.
    log('deploy.sh finished successfully.')
    return true
  }
  // Decode HOW it died instead of printing a cryptic code:
  //   status null           → killed by a signal; SIGTERM here is almost always
  //                           our own AUTO_DEPLOY_TIMEOUT_MS.
  //   130 / 143 (128+sig)   → deploy.sh trapped SIGINT/SIGTERM and exited: some
  //                           external actor (a pm2 restart/stop of this
  //                           watcher, or a Ctrl+C) interrupted the deploy —
  //                           NOT a build error and NOT a timeout.
  const how =
    res.status === null
      ? `signal ${res.signal || 'unknown'}${
          res.signal === 'SIGTERM'
            ? ` (likely AUTO_DEPLOY_TIMEOUT_MS=${cfg.deployTimeoutMs}ms exceeded)`
            : ''
        }`
      : res.status === 130 || res.status === 143
        ? `code ${res.status} (interrupted by ${
            res.status === 130 ? 'SIGINT' : 'SIGTERM'
          } — usually a pm2 restart/stop of the watcher mid-deploy, not a build error)`
        : `code ${res.status}`
  log(`deploy.sh exited with ${how} (deploy failed — will retry next cycle).`)
  ensurePanelAlive()
  return false
}

// Last line of defense after a FAILED deploy. deploy.sh has its own EXIT trap
// that un-swaps .next and re-registers the panel, but that trap cannot run if
// the script was SIGKILLed or died before bash could react. Repair both hazards
// from here so a broken deploy can never leave nginx serving 502s:
//   a) live build missing but the retired one still parked in .next.old → restore
//   b) panel deleted from PM2 but never re-started → recreate from ecosystem
function ensurePanelAlive() {
  try {
    const nextDir = path.join(REPO_ROOT, '.next')
    const oldDir = path.join(REPO_ROOT, '.next.old')
    if (!fs.existsSync(nextDir) && fs.existsSync(oldDir)) {
      log('live .next missing after failed deploy — restoring .next.old')
      fs.renameSync(oldDir, nextDir)
    }
    const probe = spawnSync('pm2', ['describe', 'omnidesk-panel'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: process.env,
      timeout: 60_000,
    })
    // `pm2 describe` exits non-zero when the process is not registered, and
    // reports "stopped" in stdout when it is registered but not running.
    const down =
      probe.status !== 0 || /status\s*│\s*stopped/i.test(probe.stdout || '')
    if (down) {
      log('panel is not running after failed deploy — recovering via pm2 ...')
      const pm2Start = () =>
        spawnSync('pm2', ['start', 'ecosystem.config.js'], {
          cwd: REPO_ROOT,
          stdio: 'inherit',
          env: process.env,
          timeout: 120_000,
        })
      let start = pm2Start()
      if (start.status !== 0) {
        // A pm2 daemon with corrupted in-memory state (the classic
        // "Cannot read properties of undefined (reading 'pm2_env')" /
        // "Process N not found" bug, triggered by deletes racing the
        // every-minute cron one-shots) fails EVERY subsequent command until
        // the daemon itself is refreshed. `pm2 update` restarts the daemon
        // in-place, re-adopting live processes — then retry the start once.
        log('pm2 start failed — refreshing the pm2 daemon (pm2 update) and retrying ...')
        spawnSync('pm2', ['update'], {
          cwd: REPO_ROOT,
          stdio: 'inherit',
          env: process.env,
          timeout: 180_000,
        })
        start = pm2Start()
      }
      if (start.status === 0) {
        spawnSync('pm2', ['save'], { cwd: REPO_ROOT, env: process.env, timeout: 60_000 })
        log('panel recovered — old version keeps serving until the retry succeeds.')
      } else {
        log('pm2 recovery failed; will try again after the next failed deploy.')
      }
    }
  } catch (err) {
    log('ensurePanelAlive error:', err?.message || err)
  }
}

async function tick() {
  if (!cfg.enabled || deploying) return
  deploying = true
  try {
    const f = git(['fetch', cfg.remote, cfg.branch, '--quiet'])
    if (!f.ok) {
      log(`git fetch failed: ${f.stderr || 'unknown error'}`)
      return
    }
    const remote = remoteSha()
    if (!remote) {
      log(`could not resolve ${cfg.remote}/${cfg.branch} after fetch`)
      return
    }
    const local = deployedSha()
    if (local === remote) return // already up to date

    // Same sha keeps failing? Honor the backoff window instead of restarting
    // the whole stack (worker + Telegram sessions) every single tick.
    if (failBackoff.sha === remote && Date.now() < failBackoff.notBefore) return

    log(
      `local ${local ? local.slice(0, 8) : 'none'} != remote ` +
        `${remote.slice(0, 8)} — deploying.`,
    )
    const ok = runDeploy()

    // Notify AFTER the outcome is known. Success is "the end-to-end marker now
    // matches remote" — not deploy.sh's exit code, which is also 0 on a lock-
    // contention skip. Failures are deduped per commit: the watcher retries
    // every cycle, and a broken build must not page you every ~30 seconds.
    const deployedNow = deployedSha()
    if (deployedNow === remote) {
      failNotifiedSha = '' // new outcome — re-arm failure notices
      failBackoff = { sha: '', failures: 0, notBefore: 0 }
      await tgSendMessage(
        `✅ OMNIDESK обновлён без ошибок\n` +
          `Ветка: ${cfg.branch}\n` +
          `Коммит: ${commitSummary(remote)}\n` +
          `Панель перезапущена, всё работает.`,
      )
    } else if (!ok) {
      noteDeployFailure(remote)
    }
    if (!ok && deployedNow !== remote && failNotifiedSha !== remote) {
      failNotifiedSha = remote
      await tgSendMessage(
        `❌ Ошибка автообновления OMNIDESK\n` +
          `Ветка: ${cfg.branch}\n` +
          `Коммит: ${commitSummary(remote)}\n` +
          `Панель продолжает работать на старой версии; ` +
          `деплой будет повторяться автоматически. Лог ошибки — в файле ниже.`,
      )
      await tgSendLogDocument(
        `Лог упавшего деплоя (${commitSummary(remote)}), последние 300 строк`,
      )
    }

    if (ok && selfHash() !== startHash) {
      log(
        'watcher source changed during this deploy; exiting so PM2 relaunches ' +
          'the updated watcher.',
      )
      process.exit(0)
    }
  } catch (err) {
    log('unexpected error:', err?.message || err)
  } finally {
    deploying = false
  }
}

function main() {
  if (!cfg.enabled) {
    log('AUTO_DEPLOY_ENABLED=false — watcher registered but idle.')
    // Stay alive so PM2 does not treat the exit as a crash and restart-loop.
    setInterval(() => {}, 1 << 30)
    return
  }
  log(
    `watching ${cfg.remote}/${cfg.branch} every ${cfg.intervalMs}ms ` +
      `(repo: ${REPO_ROOT})`,
  )
  // Print the EFFECTIVE deploy timeout so "is it 60s?" never needs guessing:
  // default is 15 minutes, overridable via AUTO_DEPLOY_TIMEOUT_MS in .env.
  log(
    `deploy timeout: ${cfg.deployTimeoutMs}ms` +
      (process.env.AUTO_DEPLOY_TIMEOUT_MS
        ? ' (from AUTO_DEPLOY_TIMEOUT_MS)'
        : ' (default; override with AUTO_DEPLOY_TIMEOUT_MS in .env)'),
  )
  log(
    tgConfigured()
      ? 'telegram deploy notifications: ON'
      : 'telegram deploy notifications: off (set DEPLOY_TG_BOT_TOKEN + DEPLOY_TG_CHAT_ID in .env to enable)',
  )
  // First check immediately on boot (so a box that is behind main catches up
  // right away), then on the interval.
  tick()
  setInterval(tick, cfg.intervalMs)
}

// Clean exit on PM2 stop/restart signals so a deploy triggered by us isn't
// interrupted awkwardly; if we're mid-deploy the spawnSync is uninterruptible
// and will finish before the process actually exits.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`received ${sig} — shutting down watcher.`)
    process.exit(0)
  })
}

main()
