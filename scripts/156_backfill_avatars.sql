-- 156_backfill_avatars.sql
-- Готовые аватарки переделаны: вместо тяжёлых мрачных «демонов» — лёгкие
-- дружелюбные мультяшные зверята (public/avatars/avatar-01.webp … avatar-20.webp,
-- каждый < 10 КБ). Старые файлы demon-XX.png удалены, поэтому:
--   1) каждому существующему аккаунту без аватарки выдаём СЛУЧАЙНЫЙ образ, чтобы
--      ни у кого никогда не было пустой аватарки;
--   2) любые ссылки на удалённые demon-XX.png (у сотрудников и у админов в
--      app_settings) переводим на случайный новый образ, иначе была бы «битая»
--      картинка.
-- random() волатильна и вычисляется для каждой строки отдельно, поэтому образы
-- раздаются вразнобой. Индексация массива в Postgres с 1: floor(random()*20)+1.

-- 1 + 2 для сотрудников (менеджеры/кураторы/руководители/байеры — одна таблица).
UPDATE managers
   SET avatar_url = (ARRAY[
     '/avatars/avatar-01.webp','/avatars/avatar-02.webp','/avatars/avatar-03.webp',
     '/avatars/avatar-04.webp','/avatars/avatar-05.webp','/avatars/avatar-06.webp',
     '/avatars/avatar-07.webp','/avatars/avatar-08.webp','/avatars/avatar-09.webp',
     '/avatars/avatar-10.webp','/avatars/avatar-11.webp','/avatars/avatar-12.webp',
     '/avatars/avatar-13.webp','/avatars/avatar-14.webp','/avatars/avatar-15.webp',
     '/avatars/avatar-16.webp','/avatars/avatar-17.webp','/avatars/avatar-18.webp',
     '/avatars/avatar-19.webp','/avatars/avatar-20.webp'
   ])[floor(random() * 20) + 1]
 WHERE avatar_url IS NULL
    OR avatar_url LIKE '/avatars/demon-%';

-- 2 для админов: их аватар лежит в app_settings (admin_avatar:{sub}) как jsonb-
-- строка. Только чиним битые demon-ссылки; пустой аватар админа (нет ключа) —
-- это норма по дизайну, насильно ничего не создаём.
UPDATE app_settings
   SET value = to_jsonb((ARRAY[
     '/avatars/avatar-01.webp','/avatars/avatar-02.webp','/avatars/avatar-03.webp',
     '/avatars/avatar-04.webp','/avatars/avatar-05.webp','/avatars/avatar-06.webp',
     '/avatars/avatar-07.webp','/avatars/avatar-08.webp','/avatars/avatar-09.webp',
     '/avatars/avatar-10.webp','/avatars/avatar-11.webp','/avatars/avatar-12.webp',
     '/avatars/avatar-13.webp','/avatars/avatar-14.webp','/avatars/avatar-15.webp',
     '/avatars/avatar-16.webp','/avatars/avatar-17.webp','/avatars/avatar-18.webp',
     '/avatars/avatar-19.webp','/avatars/avatar-20.webp'
   ])[floor(random() * 20) + 1]),
       updated_at = now()
 WHERE key LIKE 'admin_avatar:%'
   AND (value #>> '{}') LIKE '/avatars/demon-%';
