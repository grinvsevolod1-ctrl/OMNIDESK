/**
 * Готовые аватарки-образы (20 штук) — дружелюбные мультяшные зверята, лёгкие
 * WebP в public/avatars (каждый < 10 КБ, грузятся мгновенно). Пользователь
 * может выбрать образ из набора вместо загрузки своего фото. Список общий для
 * клиента (сетка выбора) и сервера (валидация значения в updateMyAvatarAction +
 * рандомная выдача при создании аккаунта), поэтому лежит вне 'use server'.
 */

/** Кол-во готовых образов. */
export const AVATAR_PRESET_COUNT = 20

/** Пути ко всем готовым образам: /avatars/avatar-01.webp … avatar-20.webp. */
export const AVATAR_PRESETS: readonly string[] = Array.from(
  { length: AVATAR_PRESET_COUNT },
  (_, i) => `/avatars/avatar-${String(i + 1).padStart(2, '0')}.webp`,
)

/** Проверка, что строка — один из известных готовых образов (для валидации). */
export function isAvatarPreset(value: string): boolean {
  return AVATAR_PRESETS.includes(value)
}

/** Случайный готовый образ — для дефолта при создании аккаунта. */
export function randomAvatarPreset(): string {
  return AVATAR_PRESETS[Math.floor(Math.random() * AVATAR_PRESETS.length)]
}
