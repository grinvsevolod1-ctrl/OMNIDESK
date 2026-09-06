-- 163_messages_client_message_id.sql
--
-- Идемпотентная отправка из композера.
--
-- До этой миграции защита от двойной отправки была только на кнопке
-- (`disabled={pending}`). Медленная сеть + повторный тап после таймаута
-- server action, ретрай Next при обрыве соединения, двойной submit с
-- клавиатуры — и клиент получал одно и то же сообщение дважды. Для продавца,
-- который пишет реальным людям, это репутационный баг.
--
-- Композер генерирует `client_message_id` (UUID) на каждую попытку отправки
-- и передаёт его в экшен; addMessage вставляет строку через
-- `ON CONFLICT DO NOTHING` по паре (conversation_id, client_message_id) и,
-- если строка уже есть, возвращает СУЩЕСТВУЮЩУЮ вместо новой — доставка не
-- ставится в очередь второй раз. Уникальность частичная: у входящих, у
-- сообщений ИИ и у строк, созданных до миграции, колонка NULL.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_message_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_client_message_id
  ON messages (conversation_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
