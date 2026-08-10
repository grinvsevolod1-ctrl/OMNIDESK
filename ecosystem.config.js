/* eslint-disable @typescript-eslint/no-require-imports */
// PM2 loads this file as CommonJS (module.exports), so require() is mandatory
// here and cannot be replaced with ESM import syntax.
//
// pm2 process config for self-hosting Omnidesk on a VPS.
//
//   pnpm install && pnpm build          # build the Next.js panel
//   cd worker && pnpm install && cd ..   # install worker deps (runs via tsx)
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup             # persist across reboots
//
// IMPORTANT — updating an already-running deploy:
//   `pm2 restart` and `pm2 reload` REUSE the process definition PM2 first saved
//   (mode, script, args). If the app was ever started differently — e.g.
//   `pm2 start pnpm -i max -- start` (cluster) or `pm2 start npm -- start`
//   (which runs `next start 3000`) — a plain restart keeps that broken
//   definition forever. Always recreate from this file after a code update:
//     rm -rf .next && pnpm install && pnpm build
//     pm2 delete omnidesk-panel omnidesk-worker omnidesk-cron-sync-ads \
//       omnidesk-cron-retry-dead-letters omnidesk-cron-followup
//     pm2 start ecosystem.config.js
//     pm2 save
//
//   Do NOT put omnidesk-auto-deploy in that delete list: it is the watcher that
//   runs deploy.sh, so deleting it mid-deploy would kill the deploy itself.
//   `pm2 start ecosystem.config.js` leaves an already-running watcher as-is.
//
// Both processes read the same .env (DATABASE_URL + ENCRYPTION_KEY must match).
const path = require('path')

// PM2 does NOT read the repo's .env by itself, and each app below runs with a
// DIFFERENT cwd (the worker runs from ./worker), so a plain `dotenv/config`
// inside a process would look for the wrong .env. Load the single root .env
// here, once, and inject it into every app's `env` so all three processes get
// an identical, complete environment regardless of their working directory.
// This is what makes the worker (DATABASE_URL/ENCRYPTION_KEY/WORKER_SECRET) and
// the cron (CRON_SECRET) actually see their required vars.
const rootEnv =
  require('dotenv').config({ path: path.join(__dirname, '.env') }).parsed || {}

module.exports = {
  apps: [
    {
      name: 'omnidesk-panel',
      script: 'node_modules/next/dist/bin/next',
      args: 'start',
      cwd: __dirname,
      instances: 1,
      // MUST be fork, never cluster. `next start` is a self-contained HTTP
      // server; running it under PM2 cluster mode spawns multiple workers that
      // each hold a DIFFERENT Server Action manifest / RSC encryption context.
      // Requests then land on a worker that didn't render the page, producing:
      //   - "Failed to find Server Action "x""
      //   - "Expected RSC response, got text/plain"
      //   - "The router state header ... could not be parsed"
      // Pinning fork mode here guarantees a single consistent instance even if
      // PM2 previously remembered a cluster definition.
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      // Restart hardening (same rationale as the worker below): a broken
      // .next after a failed deploy used to put the panel into a tight
      // restart loop (restart counter in the hundreds). Slow the loop down
      // and give up after enough unstable starts so the failure is VISIBLE
      // in `pm2 status` instead of silently churning CPU.
      min_uptime: 15000,
      restart_delay: 3000,
      exp_backoff_restart_delay: 500,
      max_restarts: 25,
      env: {
        ...rootEnv,
        NODE_ENV: 'production',
        // Bind to all interfaces so nginx (or a remote reverse proxy) can reach
        // the panel. `next start` already defaults to 0.0.0.0, but some hosts
        // default HOST to 127.0.0.1 in the environment; set it explicitly.
        HOST: '0.0.0.0',
      },
    },
    {
      name: 'omnidesk-worker',
      // Runs TypeScript via the worker's OWN locally-installed tsx (installed by
      // `cd worker && pnpm install`). We invoke it as the interpreter with an
      // absolute path so it resolves no matter what cwd PM2 uses — do NOT
      // hardcode a global path like /usr/bin/tsx (there is no global tsx).
      script: path.join(__dirname, 'worker', 'src', 'index.ts'),
      interpreter: path.join(__dirname, 'worker', 'node_modules', '.bin', 'tsx'),
      cwd: path.join(__dirname, 'worker'),
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      // The worker keeps long-lived MTProto / WhatsApp sockets — never cluster it.
      //
      // PM2's default kill_timeout is 1600ms — far too short. On restart the
      // worker's SIGTERM handler runs registry.shutdownAll(), which gracefully
      // closes every WhatsApp/Telegram socket (up to SOCKET_CLOSE_GRACE_MS each)
      // and flushes session state to Postgres. If PM2 SIGKILLs mid-teardown the
      // old sockets stay half-open, and the freshly started process reconnects
      // the same WhatsApp device into a multi-device conflict → forced 401
      // logout. Give shutdown enough headroom to finish cleanly.
      kill_timeout: 12000,
      // Process-level restart hardening: stop a transient failure (or a 401
      // storm during deploy) from becoming a tight restart-loop that keeps
      // reconnecting WhatsApp devices and getting them flagged.
      //   - min_uptime: a start only "counts" as stable after 30s; shorter runs
      //     are treated as crashes and feed the backoff/limit below.
      //   - restart_delay + exp_backoff_restart_delay: wait between restarts and
      //     grow the delay on repeated crashes instead of restarting instantly.
      //   - max_restarts: after this many unstable restarts PM2 gives up instead
      //     of looping forever (surface the failure rather than churn sockets).
      min_uptime: 30000,
      restart_delay: 5000,
      exp_backoff_restart_delay: 500,
      max_restarts: 10,
      env: {
        ...rootEnv,
        NODE_ENV: 'production',
      },
    },
    {
      // Self-hosted replacement for Vercel Cron: periodically triggers the
      // ad-sync endpoint on the local panel. Runs as a scheduled one-shot
      // (autorestart disabled, launched by cron_restart) instead of a
      // long-lived process. Requires CRON_SECRET in the shared .env.
      name: 'omnidesk-cron-sync-ads',
      script: 'scripts/cron-sync-ads.mjs',
      cwd: __dirname,
      autorestart: false,
      cron_restart: '0 */6 * * *',
      env: {
        ...rootEnv,
        NODE_ENV: 'production',
      },
    },
    {
      // Self-hosted replacement for Vercel Cron: replays the inbound webhook
      // dead-letter queue (webhook_dead_letter). Runs every minute as a
      // scheduled one-shot; the per-row exponential backoff lives in the DB, so
      // frequent runs only pick up rows that are actually due. Requires
      // CRON_SECRET in the shared .env.
      //
      // NOTE: if you update an already-running deploy, remember to include this
      // app in the `pm2 delete ...` line (see the header) before re-starting
      // from this file, otherwise PM2 keeps the old process list.
      name: 'omnidesk-cron-retry-dead-letters',
      script: 'scripts/cron-retry-dead-letters.mjs',
      cwd: __dirname,
      autorestart: false,
      cron_restart: '* * * * *',
      env: {
        ...rootEnv,
        NODE_ENV: 'production',
      },
    },
    {
      // Self-hosted replacement for Vercel Cron: sweeps for silent clients on
      // AI-led dialogs and sends gentle follow-up nudges (see
      // /api/cron/followup). Runs every 15 minutes as a scheduled one-shot; the
      // delay, quiet-hours and per-streak dedup guards live in the DB, and the
      // whole feature is OFF until an admin enables it via the co-pilot chat, so
      // frequent runs are safe. Requires CRON_SECRET in the shared .env.
      //
      // NOTE: if you update an already-running deploy, remember to include this
      // app in the `pm2 delete ...` line (see the header) before re-starting
      // from this file, otherwise PM2 keeps the old process list.
      name: 'omnidesk-cron-followup',
      script: 'scripts/cron-followup.mjs',
      cwd: __dirname,
      autorestart: false,
      cron_restart: '*/15 * * * *',
      env: {
        ...rootEnv,
        NODE_ENV: 'production',
      },
    },
    {
      // Curator daily-status push reminders: past 10:00 MSK, pushes every
      // curator who still has unconfirmed lead statuses (see
      // /api/cron/curator-status). Runs every 20 minutes; before the deadline
      // the route is a no-op and the push uses a collapse tag, so frequent
      // runs are safe. Requires CRON_SECRET in the shared .env.
      name: 'omnidesk-cron-curator-status',
      script: 'scripts/cron-curator-status.mjs',
      cwd: __dirname,
      autorestart: false,
      cron_restart: '*/20 * * * *',
      env: {
        ...rootEnv,
        NODE_ENV: 'production',
      },
    },
    {
      // OS shell scheduled commands («каждый понедельник — отчёт по лидам»):
      // sweeps due console_schedules through the shell copilot (see
      // /api/cron/console-schedules). Claiming is atomic (SKIP LOCKED), so a
      // 5-minute tick is safe. Requires CRON_SECRET in the shared .env.
      name: 'omnidesk-cron-console-schedules',
      script: 'scripts/cron-console-schedules.mjs',
      cwd: __dirname,
      autorestart: false,
      cron_restart: '*/5 * * * *',
      env: {
        ...rootEnv,
        NODE_ENV: 'production',
      },
    },
    {
      // Nightly Postgres backup with 7-day rotation (scripts/backup-db.mjs).
      // Dumps with pg_dump -Fc into ~/omnidesk-backups (override with
      // BACKUP_DIR / BACKUP_KEEP_DAYS in the shared .env). 03:30 — after the
      // day's traffic, before business hours. Requires the postgres client
      // tools on the box (apt install postgresql-client).
      name: 'omnidesk-backup-db',
      script: 'scripts/backup-db.mjs',
      cwd: __dirname,
      autorestart: false,
      cron_restart: '30 3 * * *',
      env: {
        ...rootEnv,
        NODE_ENV: 'production',
      },
    },
    {
      // Weekly VACUUM ANALYZE on the hot tables (scripts/db-vacuum-analyze.mjs)
      // so the query planner keeps fresh statistics and keeps choosing the
      // composite indexes. Plain VACUUM takes no exclusive locks — safe on a
      // live database. Sundays 04:30 — an hour after the nightly backup.
      name: 'omnidesk-db-vacuum',
      script: 'scripts/db-vacuum-analyze.mjs',
      cwd: __dirname,
      autorestart: false,
      cron_restart: '30 4 * * 0',
      env: {
        ...rootEnv,
        NODE_ENV: 'production',
      },
    },
    // NOTE: the former `omnidesk-log-reporter` process (scripts/log-reporter.mjs,
    // which pushed runtime reports to a dedicated `runtime-logs` git branch) was
    // REMOVED deliberately. Its constant commits/pushes and its participation in
    // pm2 process-list races made every deploy noisier and riskier, and the
    // branch itself confused humans ("why does the repo update every minute?").
    // deploy.sh contains a one-time cleanup that deletes the pm2 process and the
    // .runtime-logs worktree from existing boxes. Do not re-add without a very
    // good reason.
    {
      // Continuous deployment watcher: polls origin/main and runs deploy.sh
      // whenever a new commit lands, so this VPS always tracks main
      // automatically. Long-lived fork process.
      //
      // CRITICAL — do NOT add omnidesk-auto-deploy to deploy.sh's `pm2 delete`
      // line. deploy.sh is what this process spawns; deleting it mid-run would
      // SIGKILL the very process performing the deploy. It is intentionally
      // omitted there. `pm2 start ecosystem.config.js` (the last step of
      // deploy.sh) leaves an already-running auto-deploy untouched, and the
      // watcher self-restarts via PM2 if its own source changed in the deploy.
      //
      // Toggle off without removing the process: set AUTO_DEPLOY_ENABLED=false
      // in .env (the watcher then idles). Tune with AUTO_DEPLOY_BRANCH /
      // AUTO_DEPLOY_INTERVAL_MS (see scripts/auto-deploy.mjs header).
      name: 'omnidesk-auto-deploy',
      script: 'scripts/auto-deploy.mjs',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '256M',
      // CRITICAL: signal ONLY the watcher process on stop/restart. PM2's
      // default treekill walks the child tree by ppid and SIGINTs every
      // descendant — including an in-flight deploy.sh (the `detached` spawn
      // flag does NOT protect against it, only against process-GROUP
      // signals). With treekill the deploy died with exit 130, the success
      // marker was never written, and the watcher retried the same commit
      // forever. With treekill:false a `pm2 restart omnidesk-auto-deploy`
      // mid-deploy kills just the watcher; the orphaned deploy.sh finishes on
      // its own, writes the marker, and the relaunched watcher sees the box
      // as up to date.
      treekill: false,
      // Default 1.6s is fine for the watcher itself (its cleanup is one log
      // line), but be explicit so nobody "fixes" it to something huge: the
      // deploy child no longer needs the watcher alive.
      kill_timeout: 5000,
      // A deploy can take a while (install + build + migrate); don't let PM2's
      // watchdog consider a legitimately busy watcher "unstable". Back off on
      // repeated early exits instead of hammering.
      min_uptime: 20000,
      restart_delay: 10000,
      exp_backoff_restart_delay: 1000,
      max_restarts: 10,
      env: {
        ...rootEnv,
        NODE_ENV: 'production',
      },
    },
  ],
}
