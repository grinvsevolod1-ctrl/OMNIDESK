/**
 * Lead lifecycle status. A "lead" is a conversation/contact that wrote in.
 * Business model:
 *   - 'unsubscribed' (Отписок): default — everyone who ever wrote in.
 *   - 'handoff' (В работе): the AI handed the dialogue to a human, or a manager
 *     stepped into it. SYSTEM-ONLY — set automatically at the moment of
 *     takeover; from here a manager manually classifies the lead.
 *   - 'liquid' (Ликвид): on-target audience matching our parameters.
 *   - 'not_liquid' (Не ликвид): off-target; a reason is stored in statusDetail.
 *   - 'transferred' (Передан): the lead was handed to a curator (менеджер по
 *     кадрам). SYSTEM-ONLY — written by the single transfer chokepoint
 *     (`recordTransfer`) together with `conversations.curator_id`, so the
 *     status, the «Передан …» badge and the funnel «Передано» counters can never
 *     disagree. It is the ONE «передан» in the product: the inbox has no
 *     separate «Переданные» segment — picking this status in the «Статусы»
 *     filter is how a manager sees transferred threads (including ones whose
 *     lead card the curator archived or the manager trashed). Whether the
 *     manager may WRITE into such a thread is a separate question answered by
 *     managerBucket(): only after the curator gave the lead back.
 * When no status is pinned the lead defaults to 'unsubscribed'. Only «Ликвид»
 * and «Не ликвид» are set by a manager by hand.
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
 * Statuses the system assigns on its own. They are shown everywhere (chips,
 * filters, funnel) but never offered in manual pickers, and the server rejects
 * an attempt to pin them by hand — the same rule curators have for «NEW».
 */
export const SYSTEM_LEAD_STATUSES = ['handoff', 'transferred'] as const

export type SystemLeadStatus = (typeof SYSTEM_LEAD_STATUSES)[number]

export function isSystemLeadStatus(
  value: string | null | undefined,
): value is SystemLeadStatus {
  return !!value && (SYSTEM_LEAD_STATUSES as readonly string[]).includes(value)
}

/** Statuses a manager may pick by hand, in display order. */
export const SELECTABLE_LEAD_STATUSES: Exclude<LeadStatus, SystemLeadStatus>[] =
  LEAD_STATUS_ORDER.filter(
    (s): s is Exclude<LeadStatus, SystemLeadStatus> => !isSystemLeadStatus(s),
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
    label: 'В работе',
    description:
      'ИИ передал диалог менеджеру или менеджер вступил сам. Ставится автоматически',
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
    description:
      'Передан менеджеру по кадрам. Ставится автоматически при передаче лида',
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
 * System statuses («В работе», «Передан») are deliberately absent.
 */
export interface LeadStatusOption {
  value: string
  status: LeadStatus
  reason?: NotLiquidReason
  label: string
}

export const LEAD_STATUS_OPTIONS: LeadStatusOption[] =
  SELECTABLE_LEAD_STATUSES.flatMap<LeadStatusOption>((s) =>
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
