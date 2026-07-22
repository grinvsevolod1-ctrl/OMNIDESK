-- 071: RAG knowledge base for the manager brain (pgvector).
--
-- Scope: this knowledge base belongs EXCLUSIVELY to the manager brain (replies
-- to real clients). The client simulator never reads it — the two AIs stay
-- fully isolated per migration 065.
--
-- Requires the pgvector extension. text-embedding-3-small produces 1536-dim
-- vectors; keep the column dimension in sync with EMBEDDING_MODEL in
-- lib/ai/manager-brain.ts if you change the model.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS ai_knowledge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL DEFAULT '',
  content     text NOT NULL,
  -- Nullable so a row can be inserted first and embedded asynchronously; rows
  -- with NULL embedding are simply skipped by search until backfilled.
  embedding   vector(1536),
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Approximate nearest-neighbour index (cosine distance) for fast retrieval.
-- ivfflat needs ANALYZE after data loads to pick good lists; fine for our size.
CREATE INDEX IF NOT EXISTS ai_knowledge_embedding_idx
  ON ai_knowledge USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS ai_knowledge_enabled_idx
  ON ai_knowledge (enabled) WHERE enabled = true;
