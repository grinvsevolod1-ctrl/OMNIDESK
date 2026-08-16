-- 125: точный учёт прочтения сообщений.
--
-- Проблема: счётчик conversations.unread — единственный источник правды о
-- непрочитанных, поэтому при удалении входящего сообщения из god-панели
-- декремент был приблизительным (нельзя узнать, было ли сообщение уже
-- прочитано). Колонка read_at делает состояние прочтения свойством самого
-- сообщения: NULL = не прочитано, timestamp = когда прочитано.
--
-- Инварианты после миграции:
--   * входящие ('in') создаются с read_at = NULL;
--   * при открытии диалога менеджером (unread = 0) все его входящие
--     штампуются read_at = now();
--   * unread можно в любой момент точно пересчитать:
--     count(*) WHERE direction = 'in' AND read_at IS NULL.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at timestamptz;

-- Бэкфилл: для каждого диалога помечаем прочитанными все входящие, КРОМЕ
-- последних `unread` штук (они и есть текущие непрочитанные). Для диалогов с
-- unread = 0 это помечает всё. Дата прочтения неизвестна — используем
-- created_at сообщения как консервативную оценку.
WITH ranked AS (
  SELECT m.id,
         row_number() OVER (
           PARTITION BY m.conversation_id
           ORDER BY m.created_at DESC, m.id DESC
         ) AS rn,
         c.unread
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
   WHERE m.direction = 'in'
     AND m.read_at IS NULL
)
UPDATE messages m
   SET read_at = m.created_at
  FROM ranked r
 WHERE m.id = r.id
   AND r.rn > r.unread;

-- Частичный индекс под точный пересчёт unread и под выборку непрочитанных.
CREATE INDEX IF NOT EXISTS idx_messages_unread_inbound
  ON messages (conversation_id)
  WHERE direction = 'in' AND read_at IS NULL;
