-- 078_analytics_indexes.sql
--
-- Covering indexes for the analytics hot paths.
--
-- The dashboard rollups (getManagerActivityAnalytics, getGroupAnalytics,
-- getResourceLeadCounts) all pivot on the SAME shape: the FIRST inbound message
-- per conversation, i.e.
--     MIN(m.created_at) FILTER (WHERE m.direction = 'in')  GROUP BY conversation
-- and range filters like  m.direction = 'in' AND m.created_at >= $from < $to.
--
-- The existing idx_messages_conversation (conversation_id, created_at) also
-- contains OUTBOUND rows, so these scans read and discard every reply. A PARTIAL
-- index restricted to inbound messages is much smaller and lets Postgres compute
-- the per-conversation MIN and the date-range filter without touching outbound
-- traffic at all — the single biggest win for analytics on a busy panel.
--
-- Notes:
--  * The migration runner wraps each file in a transaction, so we CANNOT use
--    CREATE INDEX CONCURRENTLY. This builds under a brief lock; the partial
--    predicate keeps the build small relative to the full messages table.
--  * IF NOT EXISTS makes this migration safe to re-run.

-- Inbound-only (conversation_id, created_at): powers the first-contact CTE and
-- every inbound date-range rollup used by the analytics dashboards.
CREATE INDEX IF NOT EXISTS idx_messages_inbound_conv_created
  ON messages (conversation_id, created_at)
  WHERE direction = 'in';

-- messenger_clicks day-bucketing already has idx_messenger_clicks_created
-- (created_at DESC) and idx_messenger_clicks_channel (channel_id); the
-- (messenger) grouping is tiny-cardinality, so no extra index is needed there.
