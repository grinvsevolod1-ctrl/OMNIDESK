-- Capture live-chat messages that arrive when there is NO manager to route to.
--
-- A conversation row requires a (NOT NULL) manager_id, so when every manager
-- has been removed from a channel's pool/owner we previously had nowhere to put
-- an inbound message and dropped it (responding noAgents to the widget). That
-- silently lost a real lead. We now persist the attempt here instead, so the
-- text/contact is never lost and can be reviewed (or replayed) once a manager
-- exists again.
--
-- This table is intentionally standalone (no manager FK) precisely so it can
-- hold messages that have no manager yet.
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/037_livechat_pending_leads.sql
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS livechat_pending_leads (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id     UUID NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  contact_name   TEXT NOT NULL DEFAULT 'Website visitor',
  contact_handle TEXT NOT NULL,
  body           TEXT NOT NULL,
  meta           JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved       BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_livechat_pending_leads_channel
  ON livechat_pending_leads (channel_id, created_at DESC);
