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

const KEY = 'overview_prefs_v1'

const DEFAULTS: OverviewPrefs = {
  view: 'cards',
  preset: '7d',
  customFrom: '',
  customTo: '',
}

function load(): OverviewPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const p = JSON.parse(raw) as Partial<OverviewPrefs>
    return {
      view: p.view === 'list' ? 'list' : 'cards',
      preset:
        p.preset &&
        ['today', 'yesterday', '7d', '30d', '90d', 'custom'].includes(p.preset)
          ? p.preset
          : '7d',
      customFrom: typeof p.customFrom === 'string' ? p.customFrom : '',
      customTo: typeof p.customTo === 'string' ? p.customTo : '',
    }
  } catch {
    return DEFAULTS
  }
}

/* Мини-store поверх localStorage: кэшированный снапшот (стабильная ссылка
   для useSyncExternalStore) + подписчики. SSR отдаёт дефолты, клиент после
   гидрации мгновенно перечитывает сохранённые настройки. */
let cache: OverviewPrefs | null = null
const listeners = new Set<() => void>()

function getSnapshot(): OverviewPrefs {
  if (!cache) cache = load()
  return cache
}

function getServerSnapshot(): OverviewPrefs {
  return DEFAULTS
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function update(patch: Partial<OverviewPrefs>): void {
  cache = { ...getSnapshot(), ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {
    /* приватный режим — просто не сохраняем */
  }
  for (const l of listeners) l()
}

/**
 * Настройки Обзора, переживающие перезаход: вид (карточки/список) и
 * выбранный период. Каждое изменение сохраняется в localStorage сразу.
 */
export function useOverviewPrefs(): [
  OverviewPrefs,
  (patch: Partial<OverviewPrefs>) => void,
] {
  const prefs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return [prefs, update]
}
