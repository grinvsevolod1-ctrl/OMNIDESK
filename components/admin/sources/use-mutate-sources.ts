'use client'

import { useSWRConfig } from 'swr'

/**
 * Единая инвалидация ВСЕХ клиентских SWR-кэшей, завязанных на источники.
 *
 * Зачем: server actions делают revalidatePath + сбрасывают серверный
 * 60-сек кэш агрегатов, но SWR на клиенте держит собственный кэш и НЕ
 * реагирует на обновлённые RSC-пропсы (fallbackData учитывается только
 * при пустом кэше). Без этого хука после создания/правки/удаления
 * источника или смены канала сетка Обзора, панель деталей и селекты
 * показывают старые данные до ручной перезагрузки страницы.
 *
 * Любая мутация источников/каналов обязана вызвать этот хук.
 */
const SOURCE_KEY_PREFIXES = new Set([
  'sources-overview', // сетка карточек Обзора
  'source-detail', // панель деталей источника
  'sources-select', // селекты «Источник» (каналы, единый диалог)
])

export function useMutateSources(): () => Promise<unknown> {
  const { mutate } = useSWRConfig()
  return () =>
    mutate((key) => {
      // Ключи бывают строками ('sources-select') и массивами
      // (['sources-overview', from, to]) — матчим оба вида.
      if (typeof key === 'string') return SOURCE_KEY_PREFIXES.has(key)
      return (
        Array.isArray(key) &&
        typeof key[0] === 'string' &&
        SOURCE_KEY_PREFIXES.has(key[0])
      )
    })
}
