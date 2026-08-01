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
 *     required. This mirrors the log-reporter, which likewise talks to git only
 *     outbound.
 *
 * Config (all env vars optional):
 *   AUTO_DEPLOY_ENABLED     "false" to keep the process registered but idle.
 *   AUTO_DEPLOY_BRANCH      branch to track (default "main").
 *   AUTO_DEPLOY_REMOTE      git remote (default "origin").
 *   AUTO_DEPLOY_INTERVAL_MS poll interval in ms (default 30000, floor 5000).
 *   AUTO_DEPLOY_TIMEOUT_MS  hard cap for a single deploy.sh run (default 900000).
 *   APP_DIR                 repo checkout (default: repo root of this file).
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
}

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

function runDeploy() {
  log(`Change detected on ${cfg.remote}/${cfg.branch} — running deploy.sh ...`)
  const res = spawnSync('bash', [path.join(REPO_ROOT, 'deploy.sh')], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    // deploy.sh defaults to the checked-out branch; pin it to the tracked one.
    env: { ...process.env, DEPLOY_BRANCH: cfg.branch },
    timeout: cfg.deployTimeoutMs,
  })
  if (res.status === 0) {
    // Exit 0 covers both "deployed" and "another deploy held the lock, skipped"
    // (deploy.sh exits 0 on lock contention). Either way we're not behind for a
    // bad reason; if we skipped, the marker file is unchanged so the next tick
    // still sees a mismatch and retries. A non-zero status / signal below is
    // therefore a genuine deploy failure.
    log('deploy.sh finished successfully.')
    return true
  }
  // status === null means the child died from a SIGNAL, not an exit code — in
  // practice our own `timeout: cfg.deployTimeoutMs` SIGTERM-ing a build that
  // ran long. Say so explicitly instead of the cryptic "code null".
  const how =
    res.status === null
      ? `signal ${res.signal || 'unknown'}${
          res.signal === 'SIGTERM'
            ? ` (likely AUTO_DEPLOY_TIMEOUT_MS=${cfg.deployTimeoutMs}ms exceeded)`
            : ''
        }`
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
      const start = spawnSync('pm2', ['start', 'ecosystem.config.js'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: process.env,
        timeout: 120_000,
      })
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

    log(
      `local ${local ? local.slice(0, 8) : 'none'} != remote ` +
        `${remote.slice(0, 8)} — deploying.`,
    )
    const ok = runDeploy()
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
