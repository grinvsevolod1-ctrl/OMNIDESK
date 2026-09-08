-- 168 — Одноразовый перенос владения источниками трафика единственному байеру.
--
-- Контекст: источники (traffic_sources, миграция 145) создавались до появления
-- сущности «медиабайер» и у части из них buyer_id IS NULL («без владельца»).
-- Теперь всё завязано на байера: источник ведёт байер, менеджеры подключены к
-- источнику, лиды наследуют источник от менеджера. Эта миграция сводит уже
-- существующие данные к этой модели БЕЗ ПОТЕРЬ.
--
-- Защита от ошибки: переносим на единственного байера ТОЛЬКО если в системе
-- ровно один байер (role='buyer'). Если байеров несколько — угадывать владельца
-- нельзя, миграция ничего не трогает (решение вручную через админку). Все шаги
-- идемпотентны — повторный прогон безопасен.

DO $$
DECLARE
  v_buyer_count  int;
  v_buyer        uuid;
  v_source_count int;
  v_source       uuid;
  v_moved        int;
BEGIN
  SELECT count(*) INTO v_buyer_count FROM managers WHERE role = 'buyer';

  IF v_buyer_count <> 1 THEN
    RAISE NOTICE '168: байеров в системе % (нужен ровно 1) — данные не тронуты.',
      v_buyer_count;
    RETURN;
  END IF;

  SELECT id INTO v_buyer FROM managers WHERE role = 'buyer';

  -- 1) Источники без владельца → единственному байеру.
  UPDATE traffic_sources
     SET buyer_id = v_buyer, updated_at = now()
   WHERE buyer_id IS NULL;
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  RAISE NOTICE '168: закреплено источников за байером %: %', v_buyer, v_moved;

  -- 2) Денормализованный buyer_id в финансах приводим к владельцу источника —
  --    иначе после переназначения депозиты/траты остались бы с NULL/старым
  --    байером и выпали бы из его сводок.
  UPDATE source_deposits d
     SET buyer_id = ts.buyer_id
    FROM traffic_sources ts
   WHERE ts.id = d.source_id
     AND d.buyer_id IS DISTINCT FROM ts.buyer_id;

  UPDATE source_spend_daily s
     SET buyer_id = ts.buyer_id
    FROM traffic_sources ts
   WHERE ts.id = s.source_id
     AND s.buyer_id IS DISTINCT FROM ts.buyer_id;

  -- 3) Бутстрап единственного источника: если во всей системе он один, то
  --    принадлежность менеджеров и лидов к нему ОДНОЗНАЧНА (другого источника
  --    нет). Подключаем менеджеров продаж без источника и проставляем источник
  --    лидам без источника. При нескольких источниках угадывать нельзя — шаг
  --    пропускается, связи проставит бэкофилл из п.4 по привязке менеджера.
  SELECT count(*) INTO v_source_count FROM traffic_sources;

  IF v_source_count = 1 THEN
    SELECT id INTO v_source FROM traffic_sources;

    UPDATE managers
       SET traffic_source_id = v_source
     WHERE role = 'manager'
       AND traffic_source_id IS NULL;

    UPDATE lead_cards
       SET traffic_source_id = v_source
     WHERE traffic_source_id IS NULL;

    RAISE NOTICE '168: единственный источник % — менеджеры и лиды связаны.',
      v_source;
  ELSE
    RAISE NOTICE '168: источников % (не 1) — авто-связь менеджеров/лидов пропущена.',
      v_source_count;
  END IF;

  -- 4) Идемпотентный бэкофилл «лид → источник» по привязке его менеджера
  --    (тот же приём, что в миграции 145; безопасен при любом числе источников).
  UPDATE lead_cards lc
     SET traffic_source_id = m.traffic_source_id
    FROM managers m
   WHERE m.id = lc.manager_id
     AND lc.traffic_source_id IS NULL
     AND m.traffic_source_id IS NOT NULL;
END $$;
