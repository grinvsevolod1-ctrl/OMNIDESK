-- Global "fake 502 Bad Gateway" kill-switch, controllable only from the god
-- panel. When enabled, the admin (/admin/*) and manager (/app/*) dashboards
-- render a bogus "502 Bad Gateway" screen instead of the real app, so the
-- product looks down to everyone EXCEPT the super-admin god panel
-- (/wijegniwjgwjog), which is never gated by this flag and stays reachable to
-- flip the switch back off.
--
-- Modeled on ai_assist_settings: a singleton row (id = true) holding one bool.
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS maintenance_settings (
  id            boolean PRIMARY KEY DEFAULT true,
  -- When true, admins & managers see the fake 502 page.
  fake_502      boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_settings_singleton CHECK (id = true)
);

INSERT INTO maintenance_settings (id) VALUES (true)
  ON CONFLICT (id) DO NOTHING;
