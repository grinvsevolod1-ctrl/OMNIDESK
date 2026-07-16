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
//     pm2 delete omnidesk-panel omnidesk-worker omnidesk-cron-sync-ads
//     pm2 start ecosystem.config.js
//     pm2 save
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
  ],
}
