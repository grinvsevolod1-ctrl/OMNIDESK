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

# 2. Pull the latest code. .env is git-ignored, so it is untouched by checkout.
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

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

# 6. Recreate the PM2 processes from ecosystem.config.js. A plain `pm2 restart`
#    reuses whatever definition PM2 first saved (see the header of
#    ecosystem.config.js), so we delete and start fresh to guarantee the correct
#    fork mode, interpreter and injected env.
pm2 delete omnidesk-panel omnidesk-worker omnidesk-cron-sync-ads omnidesk-log-reporter 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 status

echo "✅ Deploy complete!"
