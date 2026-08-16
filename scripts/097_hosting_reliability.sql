-- App Hosting reliability round: port registry, app health monitoring,
-- webhook auto-deploy, per-app agent memory, and token accounting.
--
-- hosting_apps.port becomes a real allocation (unique per server) instead of a
-- hint the agent guesses at; auto_deploy opts an app into GitHub-push redeploys;
-- health_fail_count tracks consecutive failed health probes so the worker can
-- restart once and then flag the app; agent_notes is the deploy agent's memory
-- about THIS app (how it was built/run) to speed up redeploys.

ALTER TABLE hosting_apps
  ADD COLUMN IF NOT EXISTS agent_notes text;

ALTER TABLE hosting_apps
  ADD COLUMN IF NOT EXISTS auto_deploy boolean NOT NULL DEFAULT false;

ALTER TABLE hosting_apps
  ADD COLUMN IF NOT EXISTS health_fail_count integer NOT NULL DEFAULT 0;

-- One port per server: the allocator picks the smallest free port in range,
-- and this index makes double-allocation impossible even under races.
CREATE UNIQUE INDEX IF NOT EXISTS hosting_apps_server_port_uidx
  ON hosting_apps (server_id, port)
  WHERE port IS NOT NULL;

-- Token accounting per deployment (budget guardrail + cost visibility).
ALTER TABLE hosting_deployments
  ADD COLUMN IF NOT EXISTS tokens_used integer;
