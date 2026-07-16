#!/usr/bin/env node
/*
 * Omnidesk runtime log reporter (self-hosted VPS).
 *
 * WHAT IT DOES
 *   Runs as its own PM2 process next to the panel/worker/cron. On a loop it:
 *     1. reads the live status of every PM2 process (uptime, restarts, memory,
 *        crashes) via `pm2 jlist`,
 *     2. reads the tail of each process's stdout/stderr log files,
 *     3. extracts error + warning lines,
 *     4. redacts anything that looks like a secret (every value from .env, plus
 *        common token/URL/password patterns),
 *     5. writes a compact, machine- and human-readable report, and
 *     6. commits + pushes that report to a DEDICATED git branch (runtime-logs)
 *        using a separate git WORKTREE so it never touches the deployed code
 *        checkout and never conflicts with `deploy.sh`'s `git pull --ff-only`.
 *
 *   Push cadence (per the chosen design):
 *     - immediately when a NEW error/warning appears or a process crashes/
 *       restarts, and
 *     - otherwise periodically (default every 5 min) only if the report changed.
 *
 * WHY A WORKTREE + SEPARATE BRANCH
 *   The code branch is deployed with `git pull --ff-only`. If log commits landed
 *   on that same branch they'd cause non-fast-forward pull failures on every
 *   deploy. A worktree checked out to `runtime-logs` keeps log history entirely
 *   separate: the main checkout is never modified, and the runtime-logs branch
 *   only ever grows with report commits.
 *
 * CONFIG (all optional, via the shared .env / PM2 env)
 *   LOG_REPORTER_ENABLED      "false" to disable entirely (default on)
 *   LOG_REPORTER_BRANCH       target branch (default "runtime-logs")
 *   LOG_REPORTER_WORKTREE     worktree dir (default "<repo>/.runtime-logs")
 *   LOG_REPORTER_PERIODIC_MS  periodic push interval (default 300000 = 5 min)
 *   LOG_REPORTER_SCAN_MS      scan interval (default 30000 = 30 s)
 *   LOG_REPORTER_TAIL_BYTES   bytes read from the end of each log (default 65536)
 *   LOG_REPORTER_MAX_LINES    max error/warning lines kept per process (default 120)
 *   LOG_REPORTER_GIT_REMOTE   remote name to push to (default "origin")
 *   LOG_REPORTER_AUTHOR       git author "Name <email>" for log commits
 *                             (default "omnidesk-log-reporter <bot@omnidesk.local>")
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(__filename), '..')

/* --------------------------------- config -------------------------------- */

const cfg = {
  enabled: (process.env.LOG_REPORTER_ENABLED ?? 'true').toLowerCase() !== 'false',
  branch: process.env.LOG_REPORTER_BRANCH || 'runtime-logs',
  worktree:
    process.env.LOG_REPORTER_WORKTREE || path.join(REPO_ROOT, '.runtime-logs'),
  periodicMs: intEnv('LOG_REPORTER_PERIODIC_MS', 300_000),
  scanMs: intEnv('LOG_REPORTER_SCAN_MS', 30_000),
  tailBytes: intEnv('LOG_REPORTER_TAIL_BYTES', 65_536),
  maxLines: intEnv('LOG_REPORTER_MAX_LINES', 120),
  remote: process.env.LOG_REPORTER_GIT_REMOTE || 'origin',
  author:
    process.env.LOG_REPORTER_AUTHOR ||
    'omnidesk-log-reporter <bot@omnidesk.local>',
}

function intEnv(name, fallback) {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

function log(...args) {
  console.log(`[log-reporter] ${new Date().toISOString()}`, ...args)
}

/* ------------------------------- redaction ------------------------------- */

// Build a redactor from every value in the repo .env plus generic secret
// patterns, so no connection string / token / key is ever pushed to git.
function buildRedactor() {
  const secrets = new Set()
  const envPath = path.join(REPO_ROOT, '.env')
  try {
    const raw = fs.readFileSync(envPath, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (!m) continue
      let val = m[2].trim()
      // strip surrounding quotes
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      // Only redact values long enough to be a real secret (avoid nuking
      // things like NODE_ENV=production or PORT=3000).
      if (val.length >= 8) secrets.add(val)
    }
  } catch {
    /* no .env — nothing to redact from it */
  }

  // Longest-first so we redact the most specific match.
  const literals = [...secrets].sort((a, b) => b.length - a.length)

  const patterns = [
    // postgres/redis/amqp connection strings
    /\b[a-z]+:\/\/[^\s"']*:[^\s"'@]*@[^\s"']+/gi,
    // Bearer / token style
    /\bBearer\s+[A-Za-z0-9._-]+/gi,
    // long hex / base64-ish blobs (keys, tokens)
    /\b[A-Fa-f0-9]{32,}\b/g,
    /\b[A-Za-z0-9_-]{40,}\b/g,
    // key=value secrets in a line
    /((?:token|secret|password|passwd|pwd|api[_-]?key|apikey|auth|encryption[_-]?key)\s*[=:]\s*)("?[^\s"']+"?)/gi,
  ]

  return function redact(text) {
    if (!text) return text
    let out = text
    for (const lit of literals) {
      if (!lit) continue
      out = out.split(lit).join('«REDACTED»')
    }
    out = out
      .replace(patterns[0], '«REDACTED_URL»')
      .replace(patterns[1], 'Bearer «REDACTED»')
      .replace(patterns[2], '«REDACTED_HEX»')
      .replace(patterns[3], '«REDACTED_TOKEN»')
      .replace(patterns[4], '$1«REDACTED»')
    return out
  }
}

/* ------------------------------ git helpers ------------------------------ */

function git(args, opts = {}) {
  const res = spawnSync('git', args, {
    cwd: opts.cwd || REPO_ROOT,
    encoding: 'utf8',
    env: process.env,
    timeout: opts.timeout || 60_000,
  })
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
  }
}

// Ensure the runtime-logs branch exists and is checked out in its own worktree.
// Idempotent: safe to call on every process start (survives deploys).
function ensureWorktree() {
  const wt = cfg.worktree

  // Already a valid worktree with a .git link file?
  if (fs.existsSync(path.join(wt, '.git'))) {
    // Make sure git still knows about it (a manual `rm -rf` elsewhere could
    // leave a stale registration); prune stale entries either way.
    git(['worktree', 'prune'])
    return true
  }

  // Clean up any stale registration pointing at our target dir.
  git(['worktree', 'prune'])

  const branch = cfg.branch
  const localExists = git(['show-ref', '--verify', `refs/heads/${branch}`]).ok

  if (!localExists) {
    // Does it exist on the remote? If so, fetch it locally.
    const remoteLs = git(['ls-remote', '--heads', cfg.remote, branch])
    const onRemote = remoteLs.ok && remoteLs.stdout.length > 0
    if (onRemote) {
      const fetched = git([
        'fetch',
        cfg.remote,
        `${branch}:${branch}`,
      ])
      if (!fetched.ok) log('warn: fetch of existing remote branch failed:', fetched.stderr)
    } else {
      // Create a fresh, code-free branch: an initial commit pointing at the
      // empty tree. This keeps runtime-logs completely detached from the code
      // history so it can never carry source files or cause pull conflicts.
      const emptyTree = spawnSync('git', ['mktree'], {
        cwd: REPO_ROOT,
        input: '',
        encoding: 'utf8',
        env: process.env,
      })
      const treeHash = (emptyTree.stdout || '').trim()
      if (!treeHash) {
        log('error: could not create empty tree for orphan branch')
        return false
      }
      const commit = git([
        '-c',
        `user.name=${authorName()}`,
        '-c',
        `user.email=${authorEmail()}`,
        'commit-tree',
        treeHash,
        '-m',
        'chore(runtime-logs): initialize log branch',
      ])
      if (!commit.ok || !commit.stdout) {
        log('error: commit-tree failed:', commit.stderr)
        return false
      }
      const made = git(['branch', branch, commit.stdout])
      if (!made.ok) {
        log('error: could not create branch:', made.stderr)
        return false
      }
    }
  }

  fs.mkdirSync(path.dirname(wt), { recursive: true })
  const added = git(['worktree', 'add', wt, branch])
  if (!added.ok) {
    log('error: worktree add failed:', added.stderr)
    return false
  }
  log(`worktree ready at ${wt} on branch ${branch}`)
  return true
}

function authorName() {
  const m = cfg.author.match(/^(.*?)\s*<([^>]*)>\s*$/)
  return m ? m[1].trim() : cfg.author
}
function authorEmail() {
  const m = cfg.author.match(/^(.*?)\s*<([^>]*)>\s*$/)
  return m ? m[2].trim() : 'bot@omnidesk.local'
}

// Commit whatever is staged in the worktree and push. Best-effort: on a
// non-fast-forward it rebases once and retries. Never throws.
function commitAndPush(message) {
  const wt = cfg.worktree
  const add = git(['add', '-A'], { cwd: wt })
  if (!add.ok) {
    log('warn: git add failed:', add.stderr)
    return
  }
  // Nothing staged → nothing to do.
  const diff = git(['diff', '--cached', '--quiet'], { cwd: wt })
  if (diff.ok) return // exit 0 means no staged changes

  const commit = git(
    [
      '-c',
      `user.name=${authorName()}`,
      '-c',
      `user.email=${authorEmail()}`,
      'commit',
      '-m',
      message,
    ],
    { cwd: wt },
  )
  if (!commit.ok) {
    log('warn: commit failed:', commit.stderr || commit.stdout)
    return
  }
  log('committed:', message)

  let push = git(['push', cfg.remote, cfg.branch], { cwd: wt })
  if (!push.ok) {
    log('warn: push failed, trying rebase + retry:', push.stderr)
    const pull = git(
      ['pull', '--rebase', cfg.remote, cfg.branch],
      { cwd: wt },
    )
    if (pull.ok) {
      push = git(['push', cfg.remote, cfg.branch], { cwd: wt })
    }
  }
  if (push.ok) {
    log('pushed to', `${cfg.remote}/${cfg.branch}`)
  } else {
    log(
      'warn: push still failing (report is committed locally, will retry next cycle):',
      push.stderr,
    )
  }
}

/* ------------------------------ pm2 status ------------------------------- */

function readPm2() {
  const res = spawnSync('pm2', ['jlist'], {
    encoding: 'utf8',
    env: process.env,
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (res.status !== 0 || !res.stdout) {
    return { ok: false, procs: [], error: (res.stderr || 'pm2 jlist failed').trim() }
  }
  try {
    const arr = JSON.parse(res.stdout)
    const procs = arr
      // Never report on ourselves — avoids a feedback loop of "reporter logged
      // that the reporter logged...".
      .filter((p) => p.name !== 'omnidesk-log-reporter')
      .map((p) => {
        const e = p.pm2_env || {}
        return {
          name: p.name,
          status: e.status,
          pid: p.pid,
          uptimeMs: e.pm_uptime ? Date.now() - e.pm_uptime : null,
          restarts: e.restart_time ?? 0,
          unstableRestarts: e.unstable_restarts ?? 0,
          cpu: p.monit?.cpu ?? null,
          memoryBytes: p.monit?.memory ?? null,
          outLog: e.pm_out_log_path || null,
          errLog: e.pm_err_log_path || null,
          execMode: e.exec_mode,
        }
      })
    return { ok: true, procs }
  } catch (err) {
    return { ok: false, procs: [], error: `parse error: ${err.message}` }
  }
}

/* ------------------------------ log reading ------------------------------ */

// Read the last `tailBytes` of a file, return { text, size }.
function tailFile(file, tailBytes) {
  try {
    const stat = fs.statSync(file)
    const size = stat.size
    const start = Math.max(0, size - tailBytes)
    const fd = fs.openSync(file, 'r')
    try {
      const len = size - start
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, start)
      return { text: buf.toString('utf8'), size }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return { text: '', size: 0 }
  }
}

const ERROR_RE =
  /(error|exception|unhandled|fatal|econnrefused|etimedout|traceback|\bat\s+\/|\bthrow\b|rejection|crash)/i
const WARN_RE = /(warn|deprecat|retry|reconnect|timeout)/i

function classifyLines(text, maxLines) {
  const errors = []
  const warnings = []
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line) continue
    if (ERROR_RE.test(line)) {
      errors.push(line)
    } else if (WARN_RE.test(line)) {
      warnings.push(line)
    }
  }
  return {
    errors: errors.slice(-maxLines),
    warnings: warnings.slice(-maxLines),
  }
}

/* -------------------------------- report --------------------------------- */

// In-memory state for change / new-error detection across scans.
const state = {
  // per errLog path: last observed byte size (to detect growth = new stderr)
  errSizes: new Map(),
  // per proc name: last observed restart count (to detect crashes)
  restarts: new Map(),
  // hash of the last written report body (skip no-op periodic pushes)
  lastHash: null,
  lastPeriodicPush: 0,
  initialized: false,
}

function fmtBytes(n) {
  if (n == null) return '—'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`
}

function fmtDuration(ms) {
  if (ms == null) return '—'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s % 60}s`
  return `${s}s`
}

// Build the report + detect whether we should push immediately.
function buildReport(redact) {
  const pm2 = readPm2()
  const now = new Date()
  let newError = false
  const reasons = []

  const perProc = []

  if (pm2.ok) {
    for (const p of pm2.procs) {
      // Crash / restart detection.
      const prev = state.restarts.get(p.name)
      if (prev != null && p.restarts > prev) {
        newError = true
        reasons.push(`${p.name}: restarts ${prev} → ${p.restarts}`)
      }
      state.restarts.set(p.name, p.restarts)
      if (p.status && p.status !== 'online') {
        newError = true
        reasons.push(`${p.name}: status=${p.status}`)
      }

      // New stderr growth detection + tail classification.
      let errClass = { errors: [], warnings: [] }
      let outClass = { errors: [], warnings: [] }
      if (p.errLog) {
        const { text, size } = tailFile(p.errLog, cfg.tailBytes)
        const prevSize = state.errSizes.get(p.errLog)
        if (state.initialized && prevSize != null && size > prevSize) {
          newError = true
          reasons.push(`${p.name}: new stderr (+${fmtBytes(size - prevSize)})`)
        }
        state.errSizes.set(p.errLog, size)
        errClass = classifyLines(redact(text), cfg.maxLines)
      }
      if (p.outLog) {
        const { text } = tailFile(p.outLog, Math.min(cfg.tailBytes, 16384))
        outClass = classifyLines(redact(text), Math.floor(cfg.maxLines / 2))
      }

      perProc.push({ p, errClass, outClass })
    }
  } else {
    reasons.push(`pm2 unavailable: ${pm2.error}`)
  }

  // ---- Render markdown ----
  const md = []
  md.push('# Omnidesk runtime report')
  md.push('')
  md.push(`- Generated: \`${now.toISOString()}\``)
  md.push(`- Host: \`${os.hostname()}\``)
  md.push(`- Uptime (host): ${fmtDuration(os.uptime() * 1000)}`)
  md.push(
    `- Load avg: ${os
      .loadavg()
      .map((n) => n.toFixed(2))
      .join(' / ')}`,
  )
  md.push(
    `- Memory: ${fmtBytes(os.totalmem() - os.freemem())} / ${fmtBytes(os.totalmem())} used`,
  )
  md.push('')

  md.push('## Processes')
  md.push('')
  if (!pm2.ok) {
    md.push(`> ⚠️ Could not read PM2: ${pm2.error}`)
  } else if (perProc.length === 0) {
    md.push('> No PM2 processes found.')
  } else {
    md.push('| Process | Status | Uptime | Restarts | Unstable | CPU | Memory |')
    md.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const { p } of perProc) {
      const badge = p.status === 'online' ? p.status : `**${p.status}**`
      md.push(
        `| \`${p.name}\` | ${badge} | ${fmtDuration(p.uptimeMs)} | ${p.restarts} | ${p.unstableRestarts} | ${p.cpu ?? '—'}% | ${fmtBytes(p.memoryBytes)} |`,
      )
    }
  }
  md.push('')

  // Per-process errors/warnings.
  for (const { p, errClass, outClass } of perProc) {
    const errors = [...errClass.errors]
    // stdout errors can duplicate stderr; only add unique-ish extras.
    for (const l of outClass.errors) if (!errors.includes(l)) errors.push(l)
    const warnings = [...errClass.warnings]
    for (const l of outClass.warnings) if (!warnings.includes(l)) warnings.push(l)

    if (errors.length === 0 && warnings.length === 0) continue
    md.push(`## ${p.name}`)
    md.push('')
    if (errors.length) {
      md.push(`### Errors (${errors.length})`)
      md.push('```log')
      md.push(...errors.slice(-cfg.maxLines))
      md.push('```')
      md.push('')
    }
    if (warnings.length) {
      md.push(`### Warnings (${warnings.length})`)
      md.push('```log')
      md.push(...warnings.slice(-cfg.maxLines))
      md.push('```')
      md.push('')
    }
  }

  const anyIssues = perProc.some(
    ({ errClass, outClass }) =>
      errClass.errors.length ||
      outClass.errors.length ||
      errClass.warnings.length ||
      outClass.warnings.length,
  )
  if (!anyIssues && pm2.ok) {
    md.push('## Errors / warnings')
    md.push('')
    md.push('_None in the current log tail. All processes healthy._')
    md.push('')
  }

  const body = md.join('\n')

  // JSON snapshot for machine consumption.
  const json = {
    generatedAt: now.toISOString(),
    host: os.hostname(),
    pm2Ok: pm2.ok,
    pm2Error: pm2.ok ? null : pm2.error,
    processes: perProc.map(({ p, errClass, outClass }) => ({
      name: p.name,
      status: p.status,
      uptimeMs: p.uptimeMs,
      restarts: p.restarts,
      unstableRestarts: p.unstableRestarts,
      cpu: p.cpu,
      memoryBytes: p.memoryBytes,
      errorCount: errClass.errors.length + outClass.errors.length,
      warningCount: errClass.warnings.length + outClass.warnings.length,
    })),
  }

  // Hash only the "meaningful" content (exclude the timestamp line) so periodic
  // pushes are skipped when nothing actually changed.
  const hashable = body.replace(/- Generated: `[^`]*`/, '')
  const hash = crypto.createHash('sha1').update(hashable).digest('hex')

  return { body, json, hash, newError, reasons }
}

/* --------------------------------- main ---------------------------------- */

let running = false

async function cycle() {
  if (running) return
  running = true
  try {
    const redact = buildRedactor()
    const { body, json, hash, newError, reasons } = buildReport(redact)

    // Always write the current report into the worktree.
    const wt = cfg.worktree
    fs.mkdirSync(wt, { recursive: true })
    fs.writeFileSync(path.join(wt, 'runtime-report.md'), body + '\n', 'utf8')
    fs.writeFileSync(
      path.join(wt, 'runtime-status.json'),
      JSON.stringify(json, null, 2) + '\n',
      'utf8',
    )
    // A README so a fresh reader (or a new v0 chat) instantly understands the
    // branch. Written once; cheap to rewrite.
    fs.writeFileSync(path.join(wt, 'README.md'), BRANCH_README, 'utf8')

    const contentChanged = hash !== state.lastHash
    const periodicDue = Date.now() - state.lastPeriodicPush >= cfg.periodicMs

    // First run: seed baselines, push an initial snapshot so the branch is
    // populated, but don't treat pre-existing log history as "new errors".
    if (!state.initialized) {
      state.initialized = true
      state.lastHash = hash
      state.lastPeriodicPush = Date.now()
      commitAndPush(
        `chore(runtime-logs): initial snapshot @ ${json.generatedAt}`,
      )
      return
    }

    if (newError) {
      state.lastHash = hash
      state.lastPeriodicPush = Date.now()
      const why = reasons.slice(0, 4).join('; ')
      commitAndPush(
        `fix(runtime-logs): new issue @ ${json.generatedAt}${why ? ` — ${why}` : ''}`,
      )
      return
    }

    if (periodicDue && contentChanged) {
      state.lastHash = hash
      state.lastPeriodicPush = Date.now()
      commitAndPush(
        `chore(runtime-logs): periodic snapshot @ ${json.generatedAt}`,
      )
      return
    }

    // Reset the periodic timer even when content is identical, so we don't spin.
    if (periodicDue) state.lastPeriodicPush = Date.now()
  } catch (err) {
    log('error in cycle:', err?.stack || err?.message || String(err))
  } finally {
    running = false
  }
}

const BRANCH_README = `# runtime-logs

Auto-generated branch produced by \`scripts/log-reporter.mjs\` on the VPS.
Do NOT merge this branch into code branches — it only ever holds runtime reports.

- \`runtime-report.md\` — latest human-readable status + errors/warnings.
- \`runtime-status.json\` — machine-readable snapshot of the same data.

Pushed automatically: immediately on a new error/crash, and periodically when
the report changes. All secret-looking values are redacted before commit.
`

async function main() {
  if (!cfg.enabled) {
    log('disabled via LOG_REPORTER_ENABLED=false; exiting.')
    return
  }
  log('starting', {
    branch: cfg.branch,
    worktree: cfg.worktree,
    periodicMs: cfg.periodicMs,
    scanMs: cfg.scanMs,
  })

  if (!ensureWorktree()) {
    log('error: could not set up git worktree; will retry on next start.')
    // Exit non-zero so PM2 restarts us (with backoff) rather than running blind.
    process.exitCode = 1
    return
  }

  await cycle()
  const timer = setInterval(cycle, cfg.scanMs)

  const shutdown = (sig) => {
    log(`received ${sig}, flushing final report...`)
    clearInterval(timer)
    cycle().finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main()
