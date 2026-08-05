-- Media bytes move from Postgres bytea to the VPS local filesystem (run after 106).
--
-- Why: media_blobs.bytes held files up to 50 MB INSIDE Postgres. With full
-- history backfill enabled this bloats the database by gigabytes — slower
-- backups, WAL amplification, and every view buffers the whole file through a
-- DB round-trip. The bytes now live as plain files on the host filesystem
-- (MEDIA_STORE_DIR, same VPS — no third-party storage involved), and the row
-- keeps only an absolute file path plus the existing mime/name/size metadata.
--
-- Both writers (worker + panel) run on the same host, and the stored path is
-- absolute, so either process can serve any file regardless of which one
-- archived it.
--
-- `bytes` becomes nullable: new rows store NULL + file_path, legacy rows keep
-- their bytea until the worker's background offload sweep moves them to disk
-- (each batch NULLs the moved bytes, shrinking the table over time).
--
-- Safe to run multiple times.

ALTER TABLE media_blobs
  ADD COLUMN IF NOT EXISTS file_path text;

ALTER TABLE media_blobs
  ALTER COLUMN bytes DROP NOT NULL;

-- The offload sweep repeatedly asks for "legacy rows that still hold bytea".
-- Partial index keeps that scan O(pending) instead of O(all blobs).
CREATE INDEX IF NOT EXISTS idx_media_blobs_pending_offload
  ON media_blobs (created_at)
  WHERE bytes IS NOT NULL;
