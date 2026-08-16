/**
 * Lead cards: archive lifecycle — manual archive/unarchive of final leads and
 * the cron-driven auto-archive sweep (migration 117).
 */
import { query } from '../db'
import type { LeadCard } from './lead-cards-core'
import { recordStatusHistory } from './lead-history'
import { getLeadCardById } from './lead-cards-queries'

/**
 * Archive a final lead (refused/left) or unarchive it back to the active
 * workspace. Archiving requires the lead to be in a final status — active
 * leads stay under the daily gate.
 *
 * `curatorId = null` — админ: владелец не проверяется. Каждое событие пишется
 * в журнал статусов ('archived' / 'unarchived'), чтобы в истории карточки было
 * видно, кто и когда перенёс лид в архив или вернул его.
 */
export async function setLeadArchived(input: {
  leadCardId: string
  /** null — действие админа (без проверки владельца). */
  curatorId: string | null
  archived: boolean
  /** id актора для журнала, если он есть в managers (иначе NULL + снапшот). */
  actorId?: string | null
  /** Снапшот имени актора для журнала (обязателен для админа). */
  actorName?: string | null
}): Promise<LeadCard> {
  const ownerCond = input.curatorId === null ? '' : 'AND curator_id = $2'
  const params =
    input.curatorId === null
      ? [input.leadCardId]
      : [input.leadCardId, input.curatorId]
  const rows = await query<{ id: string }>(
    input.archived
      ? `UPDATE lead_cards
            SET archived_at = now(), updated_at = now()
          WHERE id = $1 ${ownerCond}
            AND status IN ('refused', 'left')
            AND archived_at IS NULL
          RETURNING id`
      : `UPDATE lead_cards
            SET archived_at = NULL, updated_at = now()
          WHERE id = $1 ${ownerCond}
            AND archived_at IS NOT NULL
          RETURNING id`,
    params,
  )
  if (!rows[0]) {
    throw new Error(
      input.archived
        ? 'В архив можно отправить только лид с финальным статусом («Отказался» или «Кинул»).'
        : 'Лид не найден в архиве.',
    )
  }
  // Журнал события — best-effort (recordStatusHistory глотает ошибки вне tx).
  await recordStatusHistory({
    leadCardId: rows[0].id,
    curatorId: input.curatorId ?? input.actorId ?? null,
    status: null,
    reason: input.archived ? 'archived' : 'unarchived',
    actorName: input.actorName ?? null,
  })
  const card = await getLeadCardById(rows[0].id)
  if (!card) throw new Error('Archive update failed')
  return card
}

/**
 * Auto-archive final leads whose final status was confirmed more than
 * `afterDays` days ago. Returns the number of leads archived. Called from
 * the curator-status cron; 0 days disables the sweep.
 */
export async function autoArchiveFinalLeads(afterDays: number): Promise<number> {
  if (afterDays <= 0) return 0
  const rows = await query<{ id: string }>(
    `UPDATE lead_cards
        SET archived_at = now(), updated_at = now()
      WHERE archived_at IS NULL
        AND transferred_at IS NOT NULL
        AND status IN ('refused', 'left')
        AND status_confirmed_at IS NOT NULL
        AND status_confirmed_at < now() - make_interval(days => $1)
      RETURNING id`,
    [afterDays],
  )
  return rows.length
}
