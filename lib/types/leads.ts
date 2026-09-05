/**
 * Lead lifecycle status. A "lead" is a conversation/contact that wrote in.
 * Business model:
 *   - 'unsubscribed' (Отписок): default — everyone who ever wrote in.
 *   - 'handoff' (Передан человеку): the AI handed the dialogue to a human, or a
 *     manager stepped into it. Set automatically at the moment of takeover; from
 *     here a manager manually classifies the lead.
 *   - 'liquid' (Ликвид): on-target audience matching our parameters.
 *   - 'not_liquid' (Не ликвид): off-target; a reason is stored in statusDetail.
 *   - 'transferred' (Передан): СИСТЕМНЫЙ статус — единый источник правды о
 *     передаче. Проставляется АВТОМАТИЧЕСКИ в момент реальной передачи лида
 *     (в пул команды или прямо куратору), см. lib/data/lead-cards-upsert.ts.
 *     Вручную не выбирается (серверный guard в setLeadStatusAction).
 * When no status is pinned the lead defaults to 'unsubscribed'. The «Ликвид» /
 * «Не ликвид» classifications are set by a manager by hand — the AI never
 * auto-assigns them; the most it does is move a lead to «Передан человеку».
 * «Передан» же следует за фактом передачи и вручную не ставится.
 */
export type LeadStatus =
  | 'unsubscribed'
  | 'handoff'
  | 'liquid'
  | 'not_liquid'
  | 'transferred'

export const LEAD_STATUS_ORDER: LeadStatus[] = [
  'unsubscribed',
  'handoff',
  'liquid',
  'not_liquid',
  'transferred',
]

/**
 * Статусы, которые менеджер выставляет ВРУЧНУЮ (пикеры / радио). «Передан»
 * (transferred) сюда НЕ входит: это системный статус — он проставляется
 * автоматически в момент передачи лида (в пул или куратору) и является единым
 * источником правды. Для фильтров и счётчиков используйте LEAD_STATUS_ORDER,
 * где «Передан» присутствует.
 */
export const MANUAL_LEAD_STATUS_ORDER: LeadStatus[] = LEAD_STATUS_ORDER.filter(
  (s) => s !== 'transferred',
)

export const LEAD_STATUS_META: Record<
  LeadStatus,
  { label: string; description: string }
> = {
  unsubscribed: {
    label: 'Отписок',
    description: 'Всего написавших людей',
  },
  handoff: {
    label: 'Передан человеку',
    description: 'ИИ передал диалог менеджеру или менеджер вступил сам',
  },
  liquid: {
    label: 'Ликвид',
    description: 'Подходящая аудитория по нужным параметрам',
  },
  not_liquid: {
    label: 'Не ликвид',
    description: 'Не подходящая аудитория',
  },
  transferred: {
    label: 'Передан',
    description: 'Подошёл, прошёл и передан дальше',
  },
}

/**
 * Reason sub-status for the «Не ликвид» bucket. Only meaningful when a lead's
 * status is 'not_liquid'.
 */
export type NotLiquidReason = 'geo' | 'under18' | 'na' | 'trash'

export const NOT_LIQUID_REASON_ORDER: NotLiquidReason[] = [
  'geo',
  'under18',
  'na',
  'trash',
]

export const NOT_LIQUID_REASON_META: Record<
  NotLiquidReason,
  { label: string; description: string }
> = {
  geo: { label: 'Гео', description: 'Не наше гео' },
  under18: { label: '-18', description: 'Младше 18 лет' },
  na: { label: 'NA', description: 'Не отвечает / не актуально' },
  trash: { label: 'TRASH', description: 'Мусорный контакт' },
}

/**
 * A single selectable status option. «Не ликвид» is expanded into its four
 * reason sub-statuses (Гео / -18 / NA / TRASH) so they appear as standalone
 * choices in pickers, while the other statuses stay as-is. `value` is a stable
 * string key for radio groups; `status`/`reason` are what to persist.
 */
export interface LeadStatusOption {
  value: string
  status: LeadStatus
  reason?: NotLiquidReason
  label: string
}

export const LEAD_STATUS_OPTIONS: LeadStatusOption[] =
  MANUAL_LEAD_STATUS_ORDER.flatMap<LeadStatusOption>((s) =>
    s === 'not_liquid'
      ? NOT_LIQUID_REASON_ORDER.map((r) => ({
          value: `not_liquid:${r}`,
          status: 'not_liquid' as LeadStatus,
          reason: r,
          label: `${LEAD_STATUS_META.not_liquid.label} · ${NOT_LIQUID_REASON_META[r].label}`,
        }))
      : [{ value: s, status: s, label: LEAD_STATUS_META[s].label }],
  )

/** Build the radio-group value for a conversation's current status + reason. */
export function leadStatusOptionValue(
  status: LeadStatus,
  reason?: NotLiquidReason | null,
): string {
  return status === 'not_liquid' && reason ? `not_liquid:${reason}` : status
}
