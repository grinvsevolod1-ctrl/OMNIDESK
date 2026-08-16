-- Worker liveness heartbeat.
--
-- The PM2 worker process writes one row (singleton, id = true) every minute.
-- The admin panel reads it to show a "worker is down" badge instead of the
-- team finding out from clients that Telegram went silent.

CREATE TABLE IF NOT EXISTS worker_heartbeat (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- Last heartbeat tick.
  beaten_at timestamptz NOT NULL DEFAULT now(),
  -- When this worker process started (resets on every restart).
  started_at timestamptz NOT NULL DEFAULT now(),
  -- Diagnostics: which process/host wrote the beat.
  pid integer,
  hostname text
);
