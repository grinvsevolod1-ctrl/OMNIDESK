/**
 * Shared types, constants and date helpers for the source-groups overview
 * (components/admin/dashboard/source-groups/). One source of truth so the
 * report, controls and management dialog can't drift apart.
 */

import type { ChannelType, PanelChannelType } from '@/lib/types'

export type ChannelOption = {
  id: string
  type: ChannelType
  name: string
  detail: string
}

export type Preset = 'today' | '7d' | '30d' | 'custom'

/**
 * Brand dot / bar colour per channel type (decorative, not themable).
 * PanelChannelType: personal-аккаунты god-панели в источники не попадают.
 */
export const TYPE_DOT: Record<PanelChannelType, string> = {
  telegram: 'bg-sky-500',
  whatsapp: 'bg-emerald-500',
  livechat: 'bg-violet-500',
  max: 'bg-amber-500',
  vk: 'bg-blue-500',
}

/** Безопасный доступ к TYPE_DOT для любого ChannelType (fallback — виджет). */
export function typeDot(type: ChannelType): string {
  return TYPE_DOT[type as PanelChannelType] ?? TYPE_DOT.livechat
}

export function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

export function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function rangeFromPreset(preset: Exclude<Preset, 'custom'>): {
  from: Date
  to: Date
} {
  const todayStart = startOfDay(new Date())
  const tomorrow = new Date(todayStart)
  tomorrow.setDate(todayStart.getDate() + 1)
  if (preset === 'today') return { from: todayStart, to: tomorrow }
  const from = new Date(todayStart)
  from.setDate(todayStart.getDate() - (preset === '7d' ? 6 : 29))
  return { from, to: tomorrow }
}
