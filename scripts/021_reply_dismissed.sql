-- Lets a manager mark a conversation as "no reply needed". We store the moment
-- of dismissal rather than a boolean flag so the "awaiting reply" state can
-- auto-reactivate: a thread is awaiting a reply only when its last inbound
-- message arrived AFTER this timestamp. A newer inbound message therefore makes
-- the thread surface again without any extra bookkeeping.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS reply_dismissed_at timestamptz;
