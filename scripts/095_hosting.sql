-- App Hosting ("Серверы") schema: self-hosted PaaS — manage a fleet of VPS and
-- deploy apps to them from Git. Mirrors the engine's design (003_engine.sql):
-- encrypted secrets at rest, a Postgres NOTIFY job queue consumed by the worker,
-- and append-only deploy logs streamed to the panel over SSE.
-- Safe to run multiple times.

/* ---------------------------- hosting_servers --------------------------- */
-- A managed VPS. SSH credentials (private key or password) are stored ONLY as
-- an AES-256-GCM envelope in secret_encrypted; host_fingerprint pins the SSH
-- host key after first connect to defeat MITM. metrics holds the latest
-- cpu/ram/disk/uptime snapshot the worker records on each health check.

CREATE TABLE IF NOT EXISTS hosting_servers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  ip_address        text NOT NULL,
  ssh_port          integer NOT NULL DEFAULT 22,
  auth_type         text NOT NULL DEFAULT 'ssh_key',      -- ssh_key | password
  ssh_username      text NOT NULL DEFAULT 'root',
  -- private key (PEM) or password, AES-256-GCM envelope (see lib/crypto.ts)
  secret_encrypted  text,
  -- SSH host key fingerprint captured on first successful connect (pinning)
  host_fingerprint  text,
  status            text NOT NULL DEFAULT 'unknown',      -- online | offline | unknown
  metrics           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { cpu, mem, disk, uptime }
  last_error        text,
  last_checked_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

/* ----------------------------- hosting_apps ----------------------------- */
-- An application deployed onto a server from a Git repo. env_encrypted holds an
-- encrypted JSON envelope of the app's environment variables. port is the local
-- port the app listens on; the reverse proxy maps domain -> 127.0.0.1:port.

CREATE TABLE IF NOT EXISTS hosting_apps (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id         uuid NOT NULL REFERENCES hosting_servers(id) ON DELETE CASCADE,
  name              text NOT NULL,
  repo_url          text NOT NULL,
  branch            text NOT NULL DEFAULT 'main',
  domain            text,
  runtime           text NOT NULL DEFAULT 'node',         -- node | docker | static | php
  -- encrypted JSON envelope: { "KEY": "value", ... }
  env_encrypted     text,
  port              integer,
  status            text NOT NULL DEFAULT 'stopped',      -- stopped | building | running | error
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hosting_apps_server ON hosting_apps(server_id);

/* -------------------------- hosting_deployments ------------------------- */
-- One row per deploy attempt for an app. Drives the deploy history list and is
-- the parent of the streamed log lines below.

CREATE TABLE IF NOT EXISTS hosting_deployments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        uuid NOT NULL REFERENCES hosting_apps(id) ON DELETE CASCADE,
  commit_hash   text,
  status        text NOT NULL DEFAULT 'queued',
  -- queued | cloning | building | running | success | failed
  trigger       text NOT NULL DEFAULT 'manual',           -- manual | redeploy
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hosting_deployments_app ON hosting_deployments(app_id);

/* -------------------------- hosting_deploy_logs ------------------------- */
-- Append-only build/run log lines. bigserial id preserves global insert order;
-- seq is the per-deployment line number the SSE route uses as the Last-Event-ID
-- cursor so a reconnecting browser resumes exactly where it left off.

CREATE TABLE IF NOT EXISTS hosting_deploy_logs (
  id             bigserial PRIMARY KEY,
  deployment_id  uuid NOT NULL REFERENCES hosting_deployments(id) ON DELETE CASCADE,
  seq            integer NOT NULL,
  stream         text NOT NULL DEFAULT 'stdout',          -- stdout | stderr | system
  line           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hosting_deploy_logs_seq
  ON hosting_deploy_logs(deployment_id, seq);

/* ------------------------------ deploy_jobs ----------------------------- */
-- Command queue for the hosting worker, parallel to channel_jobs. The panel
-- enqueues an action; the worker LISTENs on 'deploy_jobs', claims the row and
-- executes it over SSH. Long operations (clone/build) NEVER run in a serverless
-- function — only here on the worker host.

CREATE TABLE IF NOT EXISTS deploy_jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id      uuid REFERENCES hosting_servers(id) ON DELETE CASCADE,
  app_id         uuid REFERENCES hosting_apps(id) ON DELETE CASCADE,
  deployment_id  uuid REFERENCES hosting_deployments(id) ON DELETE CASCADE,
  -- action: deploy | start | stop | restart | remove | health_check
  action         text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'queued',          -- queued | running | done | error
  result         jsonb,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deploy_jobs_status
  ON deploy_jobs(status) WHERE status = 'queued';

/* ------------------------- realtime: NOTIFY hooks ------------------------ */
-- Worker LISTENs on 'deploy_jobs' to pick up new commands instantly.

CREATE OR REPLACE FUNCTION notify_deploy_jobs() RETURNS trigger AS $$
BEGIN
  IF (NEW.status = 'queued') THEN
    PERFORM pg_notify('deploy_jobs', NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_deploy_jobs ON deploy_jobs;
CREATE TRIGGER trg_notify_deploy_jobs
  AFTER INSERT ON deploy_jobs
  FOR EACH ROW EXECUTE FUNCTION notify_deploy_jobs();
