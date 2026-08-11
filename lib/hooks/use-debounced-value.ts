'use client'

import { useEffect, useState } from 'react'

/**
 * Возвращает значение, «отстающее» на `delayMs` от входного: сбрасывает
 * таймер на каждое изменение и обновляется только после паузы. Удобно для
 * поиска — перезагрузку данных вешаем на debounced-значение, а не на каждый
 * ввод в поле.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])

  return debounced
}
