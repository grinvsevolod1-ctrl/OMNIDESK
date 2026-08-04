-- OMNIDESK OS shell: dialog HISTORY. «Новый диалог» no longer destroys the
-- conversation — it is archived here, listable and restorable from the shell.

CREATE TABLE IF NOT EXISTS console_session_archive (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Admin subject from the session JWT (env-based admin => TEXT, not FK).
  user_id    TEXT NOT NULL,
  -- First user utterance of the dialog, trimmed — the list label.
  title      TEXT NOT NULL,
  -- AssistantTurn[] exactly as it was in console_sessions at archive time.
  turns      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_console_session_archive_user
  ON console_session_archive (user_id, created_at DESC);
