-- 157_backfill_transferred_status.sql
--
-- Единый источник правды для статуса «Передан» (conversations.status =
-- 'transferred').
--
-- ПРЕДЫСТОРИЯ. Раньше в системе было ДВА несвязанных понятия «передан»:
--   1) факт передачи лида куратору/в пул — фиксировался в lead_cards
--      (transferred_at / curator_id / team_id) и в conversations
--      (transferred_to_curator_at), но НЕ трогал conversations.status;
--   2) статус инбокса «Передан» (conversations.status = 'transferred') —
--      выставлялся менеджером ВРУЧНУЮ и жил отдельно от факта передачи.
-- В списке статусов это выглядело как два дубля («Передан человеку» — это ИИ
-- отдал диалог менеджеру, отдельный статус 'handoff', его НЕ трогаем).
--
-- Теперь код (lib/data/lead-cards-upsert.ts) в момент реальной передачи всегда
-- проставляет status = 'transferred'. Эта миграция ОДНОРАЗОВО подтягивает
-- историю: все диалоги, у которых передача уже состоялась, но статус ещё не
-- «Передан», приводятся к единому виду. Идемпотентна — повторный прогон ничего
-- не меняет.

-- Факт передачи лида = у карточки проставлен transferred_at ЛИБО закреплён
-- куратор/команда. Берём диалоги таких карточек, где статус ещё не 'transferred'.
UPDATE conversations c
   SET status = 'transferred',
       status_detail = NULL,
       status_updated_at = COALESCE(c.status_updated_at, now())
  FROM lead_cards lc
 WHERE lc.conversation_id = c.id
   AND c.status IS DISTINCT FROM 'transferred'
   AND (
         lc.transferred_at IS NOT NULL
      OR lc.curator_id IS NOT NULL
      OR lc.team_id IS NOT NULL
   );

-- Подстраховка по второму независимому маркеру передачи диалога куратору
-- (миграция 151): если диалог привязан к куратору, он тоже «Передан».
UPDATE conversations c
   SET status = 'transferred',
       status_detail = NULL,
       status_updated_at = COALESCE(c.status_updated_at, now())
 WHERE c.transferred_to_curator_at IS NOT NULL
   AND c.status IS DISTINCT FROM 'transferred';
