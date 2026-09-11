-- 171 — Рассылка по группам через личный Telegram-аккаунт (god-панель).
--
-- Владелец из god-панели выбирает личный аккаунт (channels.type =
-- 'telegram_personal'), добавляет ссылки/@username групп подработок и пишет
-- контекст сообщения. ИИ формирует базовый текст и УНИКАЛЬНЫЙ вариант под
-- каждую группу (обход антиспам-фильтров на идентичные сообщения). Воркер с
-- человекоподобными паузами вступает в группу, проходит бота-капчу «ты не бот?»,
-- публикует пост и повторно проходит капчу.
--
-- ПОЧЕМУ состояние в БД, если личные аккаунты по инварианту приватности
-- stateless: здесь хранится ТОЛЬКО собственный исходящий контент владельца
-- (контекст + сгенерированный текст), ПУБЛИЧНЫЕ хэндлы групп и операционные
-- статусы кампании. Это НЕ приватная переписка и НЕ списки участников —
-- их мы не храним никогда. Durable-состояние нужно для устойчивости: пауза,
-- пейсинг между отправками и resume после рестарта воркера без него невозможны.

CREATE TABLE IF NOT EXISTS broadcast_campaigns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Личный Telegram-аккаунт, ОТ ИМЕНИ которого идёт рассылка.
  channel_id    uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  -- Контекст от владельца (о чём сообщение) и сгенерированный ИИ базовый текст.
  context       text NOT NULL,
  base_text     text NOT NULL DEFAULT '',
  -- draft — черновик (можно редактировать), running — идёт рассылка,
  -- paused — приостановлена владельцем, done — все цели обработаны,
  -- failed — остановлена авто-стопом после серии ошибок.
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'running', 'paused', 'done', 'failed')),
  -- Человекоподобная пауза между отправками (сек), с джиттером в этих границах.
  min_delay_sec integer NOT NULL DEFAULT 45,
  max_delay_sec integer NOT NULL DEFAULT 90,
  -- Ответ на бота-капчу «ты не бот?» (настраивается владельцем на кампанию).
  captcha_reply text NOT NULL DEFAULT 'Я не бот, ознакомлен с правилами',
  -- Момент, раньше которого раннер не берёт следующую цель (общий пейсинг-замок
  -- на всю кампанию: FLOOD_WAIT/пауза между отправками паркуют сюда).
  not_before    timestamptz,
  -- Подряд идущие ошибки: авто-стоп кампании при достижении порога.
  consec_errors integer NOT NULL DEFAULT 0,
  last_error    text
);

CREATE INDEX IF NOT EXISTS broadcast_campaigns_channel_idx
  ON broadcast_campaigns (channel_id);

CREATE INDEX IF NOT EXISTS broadcast_campaigns_status_idx
  ON broadcast_campaigns (status, not_before);

CREATE TABLE IF NOT EXISTS broadcast_targets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      uuid NOT NULL REFERENCES broadcast_campaigns(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Как владелец ввёл группу: t.me/+invite, t.me/username, @username, username.
  raw_input        text NOT NULL,
  -- Разрешённые из Telegram метаданные (для превью и отправки). Пусты, пока
  -- цель не резолвнута.
  resolved_peer_id text,
  resolved_title   text,
  -- Уникальный вариант текста под эту группу (ИИ). Пуст, пока не сгенерирован.
  draft_text       text NOT NULL DEFAULT '',
  -- pending — ждёт, joining — вступаем, verifying — проходим капчу,
  -- sending — публикуем, sent — успех, needs_attention — требуется ручное
  -- действие (напр. графическая капча / заявка на модерацию), failed — ошибка,
  -- skipped — пропущена владельцем.
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'joining', 'verifying',
                                     'sending', 'sent', 'needs_attention',
                                     'failed', 'skipped')),
  error            text,
  attempts         integer NOT NULL DEFAULT 0,
  -- Момент готовности этой цели (per-target backoff при повторе).
  not_before       timestamptz,
  sent_at          timestamptz
);

CREATE INDEX IF NOT EXISTS broadcast_targets_campaign_idx
  ON broadcast_targets (campaign_id);

-- Очередь раннера: due-цели одной кампании в порядке создания.
CREATE INDEX IF NOT EXISTS broadcast_targets_queue_idx
  ON broadcast_targets (campaign_id, status, not_before, created_at);
