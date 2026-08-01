-- Fix slow INSERTs into ai_logs (530-700ms in the pm2 logs).
--
-- ai_logs is a capped diagnostics ring buffer (~1500 live rows, migration 058),
-- yet single-row INSERTs were taking >500ms. Three compounding causes:
--
--  1. Ring-buffer DELETE churn bloated the heap and every index with dead
--     tuples faster than default autovacuum (20% scale factor) would reclaim
--     them: at 1500 live rows autovacuum only woke up after ~300 dead ones,
--     while trim deletes arrive in bursts of hundreds.
--  2. idx_ai_logs_recent(id DESC) is fully redundant: btree indexes are
--     bidirectional, so the PRIMARY KEY already serves `ORDER BY id DESC`.
--     Every INSERT was maintaining three indexes instead of two.
--  3. Every row paid full WAL durability. This table is explicitly diagnostics
--     ("not an audit log" — 058); losing its tail on a crash is acceptable,
--     paying fsync latency on the customer-reply hot path is not.
--
-- Remedies, in order:
--
-- a) Make the table UNLOGGED: no WAL for writes — the single biggest latency
--    win on VPS disks. Deliberate trade-off: contents are truncated on crash
--    recovery (NOT on clean restart/deploy). Acceptable for a ring buffer the
--    admin tails for live visibility. The real audit trails (admin_audit_log,
--    ai_generation_metrics) remain LOGGED. SET UNLOGGED also rewrites the
--    table and its indexes, wiping ALL accumulated bloat one-time right here.
--
-- b) Drop the redundant id-DESC index (one less btree per INSERT).
--
-- c) Per-table autovacuum tuning sized for a tiny high-churn table: vacuum
--    after ~200 dead rows regardless of table size, with no cost delay, so
--    trim churn is reclaimed continuously instead of accumulating.
--
-- The writers (lib/data/ai-log.ts, worker/src/repo-ai.ts) are updated in the
-- same change: they now micro-batch inserts and trim by a cheap PK-range
-- watermark instead of an OFFSET subquery.
--
-- Safe to run multiple times.

ALTER TABLE ai_logs SET UNLOGGED;

DROP INDEX IF EXISTS idx_ai_logs_recent;

ALTER TABLE ai_logs SET (
  autovacuum_vacuum_scale_factor = 0,
  autovacuum_vacuum_threshold = 200,
  autovacuum_vacuum_cost_delay = 0,
  autovacuum_analyze_scale_factor = 0,
  autovacuum_analyze_threshold = 500
);
