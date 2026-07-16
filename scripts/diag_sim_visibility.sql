-- ---------------------------------------------------------------------------
-- ДИАГНОСТИКА: почему менеджер не видит старые диалоги симулятора.
--
-- НЕ миграция (нет числового префикса), раннер её игнорирует.
-- Запуск:
--   node --env-file=.env -e "import('pg').then(async({default:{Client}})=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();const fs=await import('node:fs/promises');const sql=await fs.readFile('scripts/diag_sim_visibility.sql','utf8');const r=await c.query(sql);console.dir(r.rows??r,{depth:null});await c.end();})"
-- либо просто через psql:
--   psql "$DATABASE_URL" -f scripts/diag_sim_visibility.sql
-- ---------------------------------------------------------------------------

\echo '== 1. Есть ли вообще сим-диалоги в БД и у каких менеджеров они закреплены =='
SELECT
  c.manager_id,
  m.name      AS manager_name,
  m.username  AS manager_login,
  m.status    AS manager_status,
  count(*)    AS sim_dialogs,
  max(c.last_message_at) AS last_activity
FROM conversations c
LEFT JOIN managers m ON m.id = c.manager_id
WHERE c.is_simulated = true
GROUP BY c.manager_id, m.name, m.username, m.status
ORDER BY sim_dialogs DESC;

\echo ''
\echo '== 2. Диалоги-сироты: is_simulated, но manager_id пустой или менеджер удалён =='
SELECT count(*) AS orphan_sim_dialogs
FROM conversations c
LEFT JOIN managers m ON m.id = c.manager_id
WHERE c.is_simulated = true
  AND (c.manager_id IS NULL OR m.id IS NULL OR m.status <> 'active');

\echo ''
\echo '== 3. Список активных менеджеров (под кем логиниться / кому передавать) =='
SELECT id, name, username, status
FROM managers
ORDER BY status, name;
