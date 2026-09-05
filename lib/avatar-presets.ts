/**
 * Готовые «демонические» аватарки (20 штук) — статические картинки в
 * public/avatars. Пользователь может выбрать образ из этого набора вместо
 * загрузки своего фото. Список общий для клиента (сетка выбора) и сервера
 * (валидация значения в updateMyAvatarAction), поэтому лежит вне 'use server'.
 */

/** Кол-во готовых образов. */
export const DEMON_AVATAR_COUNT = 20

/** Пути ко всем готовым образам: /avatars/demon-01.png … demon-20.png. */
export const DEMON_AVATARS: readonly string[] = Array.from(
  { length: DEMON_AVATAR_COUNT },
  (_, i) => `/avatars/demon-${String(i + 1).padStart(2, '0')}.png`,
)

/** Проверка, что строка — один из известных готовых образов (для валидации). */
export function isDemonAvatarPreset(value: string): boolean {
  return DEMON_AVATARS.includes(value)
}
