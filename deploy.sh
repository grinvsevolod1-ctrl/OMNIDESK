#!/bin/bash
# Zero-surprise deploy for a self-hosted Omnidesk VPS.
#
# Usage:
#   ./deploy.sh                 # deploy the branch currently checked out
#   DEPLOY_BRANCH=main ./deploy.sh   # deploy a specific branch
#
# Requirements:
#   - Run from the repo checkout (defaults to /opt/omnidesk, override with APP_DIR).
#   - A populated .env in the repo root (DATABASE_URL, ENCRYPTION_KEY, etc.).
#     It is NEVER committed and NEVER overwritten by this script.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/omnidesk}"
cd "$APP_DIR"

# Serialize deploys. A manual `./deploy.sh` and the auto-deploy watcher
# (scripts/auto-deploy.mjs) must NEVER build/migrate/swap .next at the same
# time, or two concurrent builds race on .next.new and the atomic swap.
#
# We use flock's FILE-DESCRIPTOR form (lock an fd we opened ourselves) rather
# than its exec form (`flock LOCK ./deploy.sh`). The exec form makes flock call
# execvp() on deploy.sh directly, and that raw exec can fail with
# "flock: failed to execute ...: Permission denied" (EACCES) under PM2, SELinux
# /AppArmor, or a noexec mount — even when `./deploy.sh` runs fine from an
# interactive shell (bash has ENOEXEC fallbacks that execvp does not). The fd
# form never execs anything: we just take a non-blocking lock on an open fd in
# THIS process and keep running. The kernel releases the lock automatically when
# the script exits and the fd closes, so there is nothing to clean up.
#
# If another deploy already holds the lock we exit cleanly (code 0) instead of
# clobbering its in-flight build — the watcher simply retries on its next poll.
# flock ships with util-linux and is present on any Linux VPS; if it is somehow
# missing we fall through and run unlocked rather than fail the deploy.
DEPLOY_LOCK="${DEPLOY_LOCK:-$APP_DIR/.deploy.lock}"
if command -v flock >/dev/null 2>&1; then
  # Open (or create) the lockfile on fd 9. If we can't even open it, don't abort
  # the whole deploy — fall through and run unlocked.
  if exec 9>"$DEPLOY_LOCK"; then
    # -n = non-blocking: return immediately instead of waiting if held.
    if ! flock -n 9; then
      echo "ℹ️  Another deploy is already running (lock held). Skipping this run."
      exit 0
    fi
  else
    echo "⚠️  Could not open lock file $DEPLOY_LOCK — proceeding without a lock."
  fi
fi

# ── Failsafe: never leave the box serving 502s ────────────────────────────────
# A deploy can die mid-flight (build error, or the auto-deploy watcher's
# AUTO_DEPLOY_TIMEOUT_MS killing us with SIGTERM → "exited with code null").
# The two windows that used to take the panel down permanently:
#   a) between `mv .next .next.old` and `mv .next.new .next` → no build on disk
#   b) between `pm2 delete omnidesk-panel` and `pm2 start`   → panel process gone
# This EXIT trap runs on ANY exit path (including trapped SIGTERM/SIGINT) and
# repairs both: restore the retired build if the new one wasn't promoted, and
# resurrect the panel from ecosystem.config.js if it is no longer registered.
# On a successful deploy DEPLOY_OK=1 makes the trap a no-op.
DEPLOY_OK=0
restore_panel_on_failure() {
  local code=$?
  [ "$DEPLOY_OK" = "1" ] && return 0
  echo "⚠️  Deploy did not complete (exit $code) — running failsafe recovery ..."
  # a) Un-swap: if the live build vanished but the previous one is still parked
  #    in .next.old, put it back so `next start` has something to serve.
  if [ ! -d .next ] && [ -d .next.old ]; then
    echo "   Restoring previous build from .next.old"
    mv .next.old .next || true
  fi
  # b) Resurrect: if the panel was deleted from PM2 but never re-started,
  #    recreate every app from ecosystem.config.js. `pm2 start` on an already-
  #    running app is a harmless no-op, so this is safe on every failure path.
  if ! pm2 describe omnidesk-panel >/dev/null 2>&1; then
    echo "   Panel missing from PM2 — restarting from ecosystem.config.js"
    pm2 start ecosystem.config.js || true
    pm2 save || true
  fi
  echo "⚠️  Recovery done. The OLD version keeps serving; deploy will be retried."
}
trap restore_panel_on_failure EXIT
# Convert kill signals into normal exits so the EXIT trap above actually runs
# (bash's default SIGTERM/SIGINT action skips EXIT traps). 143/130 = 128+signal.
trap 'exit 143' TERM
trap 'exit 130' INT

echo "🚀 Deploying OMNIDESK from $APP_DIR ..."

# 0. Sanity: .env must exist AND contain the vars every process needs. PM2 loads
#    this file (via ecosystem.config.js) and injects it into the panel, worker
#    and cron — so a missing/near-empty .env silently boots every service
#    without DATABASE_URL/ENCRYPTION_KEY and breaks the whole stack. Fail loudly
#    here instead. (A one-line .env created by an accidental `echo >> .env` is
#    the exact trap this guards against.)
if [ ! -f .env ]; then
  echo "❌ .env not found in $APP_DIR. Create it from .env.example first." >&2
  exit 1
fi

MISSING=""
for VAR in DATABASE_URL ENCRYPTION_KEY AUTH_SECRET WORKER_SECRET; do
  # Require a non-empty "VAR=value" line (ignoring commented-out examples).
  if ! grep -qE "^\s*${VAR}\s*=\s*\S" .env; then
    MISSING="${MISSING} ${VAR}"
  fi
done
if [ -n "$MISSING" ]; then
  echo "❌ .env is missing required values:${MISSING}" >&2
  echo "   Populate them (see .env.example) before deploying. Aborting so the" >&2
  echo "   panel/worker are not restarted with an incomplete environment." >&2
  exit 1
fi

# 0b. Server Action IDs are derived using NEXT_SERVER_ACTIONS_ENCRYPTION_KEY at
#     BUILD time. If it is unset, Next.js invents a RANDOM key on every build, so
#     every deploy changes all action IDs and any already-open browser tab breaks
#     with "Server Action ... was not found on the server". A fixed key keeps the
#     IDs stable across rebuilds. Next loads .env automatically during `pnpm
#     build`, so having it in .env is enough — we only need to guarantee it exists.
if ! grep -qE "^\s*NEXT_SERVER_ACTIONS_ENCRYPTION_KEY\s*=\s*\S" .env; then
  echo "❌ NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is missing from .env." >&2
  echo "   Without it every deploy invalidates open sessions with a" >&2
  echo "   \"Server Action was not found on the server\" error. Generate one:" >&2
  echo "     echo \"NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=\$(openssl rand -base64 32)\" >> .env" >&2
  echo "   Set it ONCE and never rotate it, then re-run ./deploy.sh. Aborting." >&2
  exit 1
fi

# 1. Figure out which branch to deploy. Default to whatever is checked out so we
#    never fail on a hardcoded branch name that doesn't exist on this machine.
BRANCH="${DEPLOY_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
echo "📦 Branch: $BRANCH"

# 2. Sync the code to exactly match the remote branch. This box is a deploy
#    MIRROR, not a dev checkout: any local edits to tracked files (e.g. a
#    deploy.sh hand-hacked while debugging on the server) must NEVER block the
#    update the way `git pull --ff-only` does with
#    "Your local changes would be overwritten by merge". So instead of a merge
#    pull we fetch and hard-reset onto origin/$BRANCH, discarding local drift.
#
#    Safety notes:
#      - .env and everything else git-ignored/untracked is left untouched —
#        `reset --hard` only touches TRACKED files.
#      - Resetting deploy.sh while it is the running script is safe: git writes
#        the new file via a temp file + rename, so this bash process keeps its
#        open handle to the old inode and finishes executing the old bytes.
git fetch origin "$BRANCH"
git checkout -f "$BRANCH"
git reset --hard "origin/$BRANCH"

# 3. Install dependencies (panel + worker) before building or migrating.
pnpm install --frozen-lockfile
(cd worker && pnpm install --frozen-lockfile)

# 4. Apply pending migrations idempotently. migrate.mjs tracks applied files in
#    the schema_migrations table (with checksums) and takes an advisory lock, so
#    re-running a deploy never re-applies or double-applies anything. We load the
#    same root .env every process uses instead of hardcoding a connection string.
echo "🗄  Applying database migrations ..."
node --env-file=.env scripts/migrate.mjs up

# 5. Rebuild the panel into a THROWAWAY directory, then swap it in atomically.
#    Deleting the live .next before building (the old approach) left the directory
#    missing for the whole ~10s build, so the still-running panel under PM2
#    crash-looped with "Could not find a production build" until the rebuild
#    finished. Building into .next.new keeps the old build serving until the very
#    last moment; the final `mv` is an atomic rename on the same filesystem.
#    NEXT_DIST_DIR is honoured by next.config.mjs (defaults to .next otherwise).
rm -rf .next.new .next.old
# Also drop the LIVE build's generated route types: tsconfig.json includes the
# ".next/types/**" glob, so a stale .next/types/validator.ts referencing since-
# deleted routes (e.g. the removed /api/wijegniwjgwjog/* endpoints) breaks the
# NEW build's type check. Types are build-time only — the running panel never
# reads them, so this is safe while the old build keeps serving.
rm -rf .next/types
NEXT_DIST_DIR=.next.new pnpm build
# Swap: retire the current build and promote the freshly built one.
[ -d .next ] && mv .next .next.old
mv .next.new .next
rm -rf .next.old
# `next build` auto-edits the git-tracked tsconfig.json / next-env.d.ts to add
# the active distDir's type globs (".next.new/types"). After the swap the real
# types live in ".next/types" — which the committed files already reference — so
# restore them to keep the working tree clean; otherwise the next deploy's
# `git checkout` / `git pull --ff-only` would fail on local modifications.
git checkout -- tsconfig.json next-env.d.ts 2>/dev/null || true

# 6. Restart the PM2 processes FROM ecosystem.config.js. `pm2 startOrRestart
#    <config>` re-applies the file's definition (script, interpreter, fork mode,
#    env) on every restart — unlike a bare `pm2 restart <name>`, which reuses
#    whatever definition PM2 first saved. So we get fresh definitions WITHOUT
#    the old `pm2 delete` + `pm2 start` dance, which had two real failure modes:
#      - a process-list race with the every-minute cron one-shots
#        ("[PM2][ERROR] Process N not found",
#         "Cannot read properties of undefined (reading 'pm2_env')")
#        that could corrupt the daemon state until `pm2 update`;
#      - a window between delete and start where the panel didn't exist at all.
#    --only pins the exact app list: omnidesk-auto-deploy MUST stay out of it —
#    it is the watcher whose child is this very script, and restarting it here
#    would SIGINT the in-flight deploy (exit 130). It self-restarts after the
#    deploy when its source changed.
# One-time cleanup of the RETIRED log-reporter (see ecosystem.config.js note):
# delete its pm2 process, its git worktree and the remote-tracking clutter it
# left behind. Every step is idempotent and safe on boxes that never had it.
pm2 delete omnidesk-log-reporter 2>/dev/null || true
git worktree remove --force .runtime-logs 2>/dev/null || true
rm -rf .runtime-logs
git branch -D runtime-logs 2>/dev/null || true

PM2_APPS="omnidesk-panel,omnidesk-worker,omnidesk-cron-sync-ads,omnidesk-cron-retry-dead-letters,omnidesk-cron-followup"
if ! pm2 startOrRestart ecosystem.config.js --only "$PM2_APPS" --update-env; then
  # A corrupted pm2 daemon fails every command until refreshed. `pm2 update`
  # restarts the daemon in-place (processes keep running), then retry once.
  echo "⚠️  pm2 startOrRestart failed — refreshing the pm2 daemon and retrying ..."
  pm2 update || true
  pm2 startOrRestart ecosystem.config.js --only "$PM2_APPS" --update-env
fi
# Create any app missing from the process list (e.g. a brand-new box or a new
# app added to the config, including the auto-deploy watcher itself): plain
# `pm2 start <config>` starts absent apps and leaves running ones untouched.
pm2 start ecosystem.config.js 2>/dev/null || true

# 7. Record the commit that was ACTUALLY deployed end-to-end. The auto-deploy
#    watcher compares origin/<branch> against THIS marker (not `git rev-parse
#    HEAD`) to decide whether to deploy: step 2 above hard-resets HEAD to the
#    remote sha long before the build/restart succeed, so a deploy killed
#    mid-flight used to leave HEAD == remote and the watcher never retried —
#    the panel stayed down until a human intervened. The marker is only written
#    past every REAL failure point (build, swap, pm2 restart).
#
#    IMPORTANT ordering + `|| true` on the cosmetic pm2 commands below: this
#    script runs under `set -e`, and `pm2 save` / `pm2 status` used to sit
#    UNGUARDED between the worker restart and this marker. Any transient pm2
#    hiccup there aborted the script AFTER the apps were already restarted but
#    BEFORE the marker was written — so the watcher retried the "failed" deploy
#    every 30s, each retry restarting the worker and force-reconnecting every
#    Telegram account in an endless loop. The apps are running at this point;
#    nothing after the restart may be allowed to fail the deploy.
git rev-parse HEAD > .deploy.last-success 2>/dev/null || true

pm2 save || true
pm2 status || true

DEPLOY_OK=1
echo "✅ Deploy complete!"
