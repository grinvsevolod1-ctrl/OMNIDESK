-- 079_manager_temp_password.sql
--
-- Optional "temporary password" for managers, managed from the God panel.
--
-- The primary `password_hash` is a bcrypt hash (one-way): the original password
-- can never be shown back. This column is a SEPARATE, additional credential that
-- an operator can set/generate from the God panel and READ back at any time.
--
-- It is stored ENCRYPTED at rest (AES-256-GCM via lib/crypto, the same envelope
-- used for Telegram sessions / proxy creds), never as plaintext, so a DB dump
-- alone does not leak it — decryption requires ENCRYPTION_KEY. It is completely
-- independent of the main password: setting/clearing it does NOT touch
-- password_hash or session_version, and logging in with it behaves exactly like
-- a normal login. Either credential works.

ALTER TABLE managers
  ADD COLUMN IF NOT EXISTS temp_password_enc    TEXT,
  ADD COLUMN IF NOT EXISTS temp_password_set_at TIMESTAMPTZ;
