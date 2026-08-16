-- 096_hosting_ai.sql — AI-driven deploy layer for the "Серверы" console.
--
-- Additive & idempotent: extends the tables from 095_hosting.sql so the
-- autonomous deploy agent can record its reasoning, remember servers, and clone
-- private repositories. Safe to run repeatedly (IF NOT EXISTS everywhere).
--
-- Notes on free-text columns reused as lightweight enums:
--   * hosting_deploy_logs.stream now also carries 'agent' (the model's
--     reasoning) and 'command' (a command the agent decided to run), alongside
--     the existing 'stdout' | 'stderr' | 'system'. The column is plain text so
--     no type change is required.
--   * hosting_deployments.mode is 'manual' (classic pipeline) or 'ai'
--     (autonomous agent). Defaults to 'manual' so existing rows are unchanged.
--   * deploy_jobs.action now also accepts 'ai_deploy'. The column is plain text.

-- Deployments: how the deploy ran + a human-readable summary and resolved URL.
ALTER TABLE hosting_deployments
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'manual';
ALTER TABLE hosting_deployments
  ADD COLUMN IF NOT EXISTS summary text;
ALTER TABLE hosting_deployments
  ADD COLUMN IF NOT EXISTS site_url text;

-- Apps: encrypted GitHub token for cloning private repositories over HTTPS.
ALTER TABLE hosting_apps
  ADD COLUMN IF NOT EXISTS repo_token_encrypted text;

-- Servers: the agent's short memory about a box (OS, what's already installed),
-- so repeat deploys skip redundant analysis/installs.
ALTER TABLE hosting_servers
  ADD COLUMN IF NOT EXISTS agent_notes text;

-- Helpful index for tailing an AI deployment's logs by cursor (already the hot
-- path for the SSE route; explicit here in case 095 predates heavy log volume).
CREATE INDEX IF NOT EXISTS hosting_deploy_logs_deployment_seq_idx
  ON hosting_deploy_logs (deployment_id, seq);
