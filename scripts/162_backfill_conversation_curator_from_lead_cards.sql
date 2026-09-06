-- 162_backfill_conversation_curator_from_lead_cards.sql
--
-- Сводим две ссылки «этот куратор ведёт этот лид» к одному факту.
--
-- Куратор видит лид по lead_cards.curator_id, а «Чаты» куратора и гейт
-- ИИ-менеджера (isConversationAiLed: `curator_id IS NULL`) читают
-- conversations.curator_id (миграция 151). Вторая ссылка пишется chokepoint'ом
-- recordTransfer — но лиды, переданные ДО миграции 151, и лиды, у которых
-- диалог появился позже карточки (outreach → conversation_id проставлен
-- задним числом), остались с картой у куратора и диалогом БЕЗ curator_id.
--
-- Последствие не косметическое: у таких диалогов ИИ менеджера считал тред
-- своим и отвечал клиенту ПОВЕРХ куратора, а фото у куратора отдавали 404
-- (владение медиа проверялось только по conversations.curator_id — в коде
-- уже расширено до «любая из двух ссылок», см. getMessageOwnerForCurator).
--
-- Правило бэкофилла: диалог без curator_id + активная (не архивная,
-- не удалённая) карточка с куратором → привязываем к этому куратору ровно
-- так, как это сделал бы recordTransfer: curator_id, transferred_to_curator_at
-- (берём из карточки время передачи/создания, а не now(), чтобы не врать в
-- «Передан вам»), ai_paused, статус «Передан» (миграция 161).
--
-- Обратное расхождение (curator_id стоит, карточки нет) не трогаем:
-- unlinkConversationFromCurator в коде не вызывается, такие строки могли
-- появиться только руками — их разбирать отдельно.
--
-- Идемпотентно: повторный запуск ничего не меняет.

UPDATE conversations c
   SET curator_id = lc.curator_id,
       transferred_to_curator_at = COALESCE(
         c.transferred_to_curator_at,
         lc.transferred_at,
         lc.created_at,
         now()
       ),
       ai_paused = true,
       status = 'transferred',
       status_detail = NULL,
       status_updated_at = COALESCE(c.status_updated_at, now())
  FROM lead_cards lc
 WHERE lc.conversation_id = c.id
   AND lc.curator_id IS NOT NULL
   AND lc.archived_at IS NULL
   AND lc.deleted_at IS NULL
   AND c.curator_id IS NULL;
