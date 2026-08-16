-- 136: God-sites browser-extension generator ("Сайты бета").
--
-- The god panel can now generate a ready-to-install Chrome extension per
-- managed site (slug + fresh token + API origin baked in), replacing the old
-- manual "paste the token into config.js by hand" flow.
--
-- Two bookkeeping columns on god_sites drive the generated manifest.json:
--
--   ext_label_seq — the N in the extension display name "яндекс N". Assigned
--     ONCE, on the first download for a site, as MAX(ext_label_seq)+1 across
--     all sites. Numbering starts at 11 (first ever generated = "яндекс 11"),
--     so it never collides with any manually-made extension already in use.
--     Stays fixed for the life of the site.
--
--   ext_version — a monotonic download counter. Every download bumps it, and
--     the manifest version becomes "1.0.<ext_version>". Chrome refuses to
--     "reload/update" an unpacked extension whose version did not change, so a
--     fresh version on every download guarantees the operator always installs
--     the newest token.
--
-- Neither column carries any secret: the plaintext token is shown only in the
-- generated zip at download time (DB still stores only the SHA-256 hash, as in
-- migration 132). This module remains part of the sacred god-panel invariant
-- (AGENTS.md section 4).
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/136_god_sites_ext.sql

ALTER TABLE god_sites
  ADD COLUMN IF NOT EXISTS ext_label_seq INT,
  ADD COLUMN IF NOT EXISTS ext_version INT NOT NULL DEFAULT 0;

-- One site owns at most one label number.
CREATE UNIQUE INDEX IF NOT EXISTS idx_god_sites_ext_label_seq
  ON god_sites (ext_label_seq)
  WHERE ext_label_seq IS NOT NULL;
