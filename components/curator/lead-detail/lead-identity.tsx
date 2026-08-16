'use client'

import { TextInlineEditor } from '@/components/admin/lead-inline-edit'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import { leadNeedsDailyStatus } from '@/lib/lead-status'
import type { LeadCardView } from './types'

/** ФИО и должность (правятся кликом — как в админской таблице) + бейдж статуса. */
export function LeadIdentity({
  card,
  onFieldSaved,
}: {
  card: LeadCardView
  onFieldSaved: () => void
}) {
  return (
    <div>
      <TextInlineEditor
        lead={card}
        field="full_name"
        label="ФИО"
        display={card.fullName || 'Без имени'}
        className="text-lg font-semibold tracking-tight"
        onSaved={onFieldSaved}
      />
      <div className="text-sm text-muted-foreground">
        <TextInlineEditor
          lead={card}
          field="vacancy"
          label="Должность"
          display={card.vacancy}
          placeholder="Курьер, водитель…"
          onSaved={onFieldSaved}
        />
      </div>
      <div className="mt-2">
        <LeadStatusBadge
          status={card.status}
          needsUpdate={leadNeedsDailyStatus(card)}
          previousStatus={card.previousStatus}
        />
      </div>
    </div>
  )
}
