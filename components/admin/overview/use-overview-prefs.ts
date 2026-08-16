'use client'

import { useSyncExternalStore } from 'react'

export type OverviewView = 'cards' | 'list'
export type PeriodPreset =
  | 'today'
  | 'yesterday'
  | '7d'
  | '30d'
  | '90d'
  | 'custom'

export interface OverviewPrefs {
  view: OverviewView
  preset: PeriodPreset
  /** YYYY-MM-DD, только для preset='custom'. */
  customFrom: string
  customTo: string
}

const DEFAULTS: OverviewPrefs = {
  view: 'cards',
  preset: '7d',
  customFrom: '',
  customTo: '',
}

/* Мини-store поверх localStorage: кэшированный снапшот (стабильная ссылка
   для useSyncExternalStore) + подписчики. SSR отдаёт дефолты, клиент после
   гидрации мгновенно перечитывает сохранённые настройки. Фабрика — чтобы
   у админа и менеджера были НЕЗАВИСИМЫЕ настройки (разные ключи). */
function createPrefsStore(key: string) {
  let cache: OverviewPrefs | null = null
  const listeners = new Set<() => void>()

  function load(): OverviewPrefs {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return DEFAULTS
      const p = JSON.parse(raw) as Partial<OverviewPrefs>
      return {
        view: p.view === 'list' ? 'list' : 'cards',
        preset:
          p.preset &&
          ['today', 'yesterday', '7d', '30d', '90d', 'custom'].includes(
            p.preset,
          )
            ? p.preset
            : '7d',
        customFrom: typeof p.customFrom === 'string' ? p.customFrom : '',
        customTo: typeof p.customTo === 'string' ? p.customTo : '',
      }
    } catch {
      return DEFAULTS
    }
  }

  return {
    getSnapshot(): OverviewPrefs {
      if (!cache) cache = load()
      return cache
    },
    getServerSnapshot(): OverviewPrefs {
      return DEFAULTS
    },
    subscribe(cb: () => void): () => void {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    update(patch: Partial<OverviewPrefs>): void {
      cache = { ...(cache ?? load()), ...patch }
      try {
        localStorage.setItem(key, JSON.stringify(cache))
      } catch {
        /* приватный режим — просто не сохраняем */
      }
      for (const l of listeners) l()
    },
  }
}

const adminStore = createPrefsStore('overview_prefs_v1')
const managerStore = createPrefsStore('manager_overview_prefs_v1')

/**
 * Настройки Обзора админа, переживающие перезаход: вид (карточки/список) и
 * выбранный период. Каждое изменение сохраняется в localStorage сразу.
 */
export function useOverviewPrefs(): [
  OverviewPrefs,
  (patch: Partial<OverviewPrefs>) => void,
] {
  const prefs = useSyncExternalStore(
    adminStore.subscribe,
    adminStore.getSnapshot,
    adminStore.getServerSnapshot,
  )
  return [prefs, adminStore.update]
}

/** То же для обзора каналов менеджера — независимый ключ хранения. */
export function useManagerOverviewPrefs(): [
  OverviewPrefs,
  (patch: Partial<OverviewPrefs>) => void,
] {
  const prefs = useSyncExternalStore(
    managerStore.subscribe,
    managerStore.getSnapshot,
    managerStore.getServerSnapshot,
  )
  return [prefs, managerStore.update]
}
