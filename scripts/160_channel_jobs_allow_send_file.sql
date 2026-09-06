-- 160_channel_jobs_allow_send_file.sql
--
-- Корень «Медиа недоступно» для фото/файлов из композера Telegram (менеджер
-- и куратор). Действие 'send_file' появилось в JobAction и в switch воркера,
-- но CHECK-constraint channel_jobs_action_check в последний раз переустанавливали
-- в миграции 103 — БЕЗ 'send_file'. Итог на проде:
--
--   addMessage() создаёт строку исходящего  →  enqueueJob('send_file') падает
--   на INSERT (violates check constraint)   →  markMessageFailed(...)
--
-- Сообщение висит в треде без provider id, без джоба и (до 9516e8d) без байт —
-- в Telegram оно НЕ уходило вообще. Диагностика `/api/media/{id}?diag=1`
-- показывала ровно это: providerId=false, job=null, blob=empty.
--
-- Переустанавливаем constraint с ПОЛНЫМ набором JobAction (lib/types/jobs.ts)
-- плюс исторический 'request_qr', чтобы старые строки продолжали валидироваться.
-- Согласованность трёх списков (тип, switch воркера, эта миграция) теперь
-- закреплена тестом lib/data/jobs-action-check.test.ts — новое действие без
-- новой миграции больше не пройдёт CI.
ALTER TABLE channel_jobs DROP CONSTRAINT IF EXISTS channel_jobs_action_check;
ALTER TABLE channel_jobs ADD CONSTRAINT channel_jobs_action_check CHECK (
  action IN (
    'start', 'start_qr', 'stop', 'restart', 'request_qr', 'logout',
    'pause', 'resume',
    'send_code', 'send_password',
    'send_message', 'forward_message', 'send_sticker', 'send_voice', 'send_file',
    'mark_read', 'set_typing', 'react_message', 'delete_message',
    'edit_message',
    'kick_foreign_sessions'
  )
) NOT VALID;
