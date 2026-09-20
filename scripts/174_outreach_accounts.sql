-- 174 — Исходящий контур: пул купленных Telegram-аккаунтов.
--
-- Боевые аккаунты для холодных касаний лидов. Каждый аккаунт:
--   * привязан к api-ключу из пула (outreach_api_keys) — анти-бан;
--   * держит СОБСТВЕННУЮ MTProto-сессию (session_enc) и персональный SOCKS5-прокси
--     (proxy_enc) — каждый аккаунт со своего IP, иначе Telegram банит пачками;
--   * фиксирует «устройство» (device_model/system_version/app_version) один раз —
--     смена устройства между сессиями это красный флаг для анти-фрод Telegram;
--   * проходит ПРОГРЕВ (warmup_stage/warmup_day) прежде чем писать чужим;
--   * мониторится на спам-блок (@SpamBot → spamblock_status/spamblock_until);
--   * считает дневные/часовые лимиты (капы) для человекоподобного темпа.
--
-- Аккаунт САМ НЕ хранит переписку в общем inbox: как и god-панельные личные
-- аккаунты, исходящий аккаунт живёт в «личном» режиме — тред читается живьём
-- через worker/src/personal.ts, а бизнес-факты (кому и когда написали, ответили
-- ли) фиксируются на outreach_leads. Ядро seller-инбокса не затрагивается.

CREATE TABLE IF NOT EXISTS outreach_accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                text NOT NULL DEFAULT '',
  phone                text,
  api_key_id           uuid REFERENCES outreach_api_keys(id) ON DELETE SET NULL,

  -- Живая MTProto-сессия аккаунта живёт на связанном канале (type
  -- 'telegram_personal', config.outreach=true): весь проверенный конвейер
  -- подключения/отправки воркера переиспользуется без изменений. Здесь же
  -- хранится анти-бан-состояние (прогрев, спам-блок, api-ключ, счётчики).
  channel_id           uuid REFERENCES channels(id) ON DELETE SET NULL,

  -- Секреты (lib/crypto, AES-256-GCM). Резерв на случай автономных сессий.
  session_enc          text,
  proxy_enc            text,

  -- Стабильная «личность устройства» — фиксируется при подключении, не меняется.
  device_model         text,
  system_version       text,
  app_version          text,

  -- Жизненный цикл сессии/аккаунта.
  status               text NOT NULL DEFAULT 'new',
  -- Спам-блок из диалога с @SpamBot.
  spamblock_status     text NOT NULL DEFAULT 'unknown',
  spamblock_checked_at timestamptz,
  spamblock_until      timestamptz,

  -- Прогрев.
  warmup_stage         text NOT NULL DEFAULT 'cold',
  warmup_day           integer NOT NULL DEFAULT 0,
  warmup_started_at    timestamptz,

  -- Счётчики темпа (сбрасываются кроном/тиком).
  daily_sent           integer NOT NULL DEFAULT 0,
  daily_joins          integer NOT NULL DEFAULT 0,
  hourly_sent          integer NOT NULL DEFAULT 0,
  counters_reset_at    timestamptz,

  -- Общий пул, но можно закрепить аккаунт за менеджером.
  assigned_manager_id  uuid REFERENCES managers(id) ON DELETE SET NULL,

  -- Планировщик прогрева/отправки: не трогать раньше этого момента (парковка
  -- FLOOD_WAIT, человеческие паузы) — по образцу broadcast_targets.not_before.
  not_before           timestamptz,
  last_action_at       timestamptz,
  last_error           text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT outreach_accounts_status_check CHECK (
    status IN (
      'new', 'connecting', 'code_pending', 'password_pending',
      'online', 'offline', 'error', 'banned', 'quarantined', 'logged_out'
    )
  ),
  CONSTRAINT outreach_accounts_spamblock_check CHECK (
    spamblock_status IN ('unknown', 'clean', 'limited', 'blocked')
  ),
  CONSTRAINT outreach_accounts_warmup_check CHECK (
    warmup_stage IN ('cold', 'warming', 'ready')
  )
);

-- Планировщики берут «созревшие» аккаунты пачками с FOR UPDATE SKIP LOCKED.
CREATE INDEX IF NOT EXISTS outreach_accounts_scheduler_idx
  ON outreach_accounts (status, warmup_stage, not_before);

CREATE INDEX IF NOT EXISTS outreach_accounts_manager_idx
  ON outreach_accounts (assigned_manager_id);

CREATE INDEX IF NOT EXISTS outreach_accounts_api_key_idx
  ON outreach_accounts (api_key_id);
