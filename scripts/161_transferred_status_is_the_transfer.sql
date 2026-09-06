-- 161_transferred_status_is_the_transfer.sql
--
-- Один «передан» вместо трёх.
--
-- До этой миграции в инбоксе менеджера рядом жили: статус лида «Передан»
-- (transferred — ставился ТОЛЬКО руками, ни одно место в коде не выставляло
-- его само), статус «Передан человеку» (handoff — ставился автоматически,
-- когда ИИ отдал диалог или менеджер просто написал первым) и реальная
-- передача куратору (conversations.curator_id, миграция 151) с отдельным
-- чипом «Переданные» в шапке списка. Три счётчика с одним словом давали три
-- разных числа, а на одной строке одновременно висели «Передан человеку ·
-- авто» и бейдж «Передан Ивановой».
--
-- Новое правило:
--   * 'transferred' («Передан») = ФАКТ передачи диалога куратору. Пишется
--     единым chokepoint'ом recordTransfer (и linkConversationToCurator /
--     аутричем куратора) вместе с curator_id; вручную не выбирается и не
--     сбрасывается (setConversationStatus возвращает 'locked'). В инбоксе
--     менеджера нет отдельного сегмента «Переданные» — переданные диалоги
--     показывает выбор этого статуса в фильтре «Статусы», независимо от того,
--     в архиве карточка у куратора или в trash у менеджера. Писать в них
--     менеджер может только когда куратор вернул лид (managerBucket).
--   * 'handoff' переименован в «В работе» и тоже стал системным: это стадия
--     «ИИ → человек», а не передача.
--
-- Схема не меняется — только данные.

-- 1. Бэкофилл: все диалоги, уже привязанные к куратору, получают статус
--    «Передан» (то, что с этого момента пишет recordTransfer).
UPDATE conversations
   SET status = 'transferred',
       status_detail = NULL,
       status_updated_at = COALESCE(transferred_to_curator_at, status_updated_at, now())
 WHERE curator_id IS NOT NULL
   AND status IS DISTINCT FROM 'transferred';

--    Исторические «Передан» без curator_id (выставлены руками до появления
--    карточек лидов, миграция 151) СОЗНАТЕЛЬНО не трогаем: это реальные
--    передачи прошлых периодов, воронка за те месяцы должна сходиться.
--    Новых таких строк не появится — ручной выбор статуса закрыт.

-- 2. Словари: подписи хранятся в app_settings полным снимком (seed-dictionaries
--    / saveDictionaries), поэтому смена дефолта в коде сама по себе UI не
--    изменит. Переименовываем только если админ не менял подпись сам.
UPDATE app_settings
   SET value = jsonb_set(value, '{leadStatuses,handoff,label}', '"В работе"'),
       updated_at = now()
 WHERE key = 'dictionaries'
   AND value #>> '{leadStatuses,handoff,label}' = 'Передан человеку';

UPDATE app_settings
   SET value = jsonb_set(
         value,
         '{leadStatuses,handoff,description}',
         '"ИИ передал диалог менеджеру или менеджер вступил сам. Ставится автоматически"'
       ),
       updated_at = now()
 WHERE key = 'dictionaries'
   AND value #>> '{leadStatuses,handoff,description}'
       = 'ИИ передал диалог менеджеру или менеджер вступил сам';

UPDATE app_settings
   SET value = jsonb_set(
         value,
         '{leadStatuses,transferred,description}',
         '"Передан менеджеру по кадрам. Ставится автоматически при передаче лида"'
       ),
       updated_at = now()
 WHERE key = 'dictionaries'
   AND value #>> '{leadStatuses,transferred,description}'
       = 'Подошёл, прошёл и передан дальше';
