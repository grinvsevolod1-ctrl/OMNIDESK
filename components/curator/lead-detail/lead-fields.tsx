'use client'

import {
  CityInlineEditor,
  TextInlineEditor,
} from '@/components/admin/lead-inline-edit'
import { formatDateTime } from './format'
import type { LeadCardView } from './types'

/**
 * Реквизиты лида: телефон, Telegram, город, адрес — правятся кликом;
 * менеджер, менеджер по кадрам (у админа и руководителя) и дата передачи —
 * только чтение. readOnly (руководитель «только просмотр») отключает правку.
 */
export function LeadDetailFields({
  card,
  variant,
  onFieldSaved,
  readOnly = false,
}: {
  card: LeadCardView
  variant: 'curator' | 'admin' | 'head'
  onFieldSaved: () => void
  readOnly?: boolean
}) {
  return (
    <dl className="grid gap-2.5 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-xs text-muted-foreground">Телефон</dt>
        <dd className="font-medium">
          {readOnly ? (
            <span>{card.phone || '—'}</span>
          ) : (
            <TextInlineEditor
              lead={card}
              field="phone"
              label="Телефон"
              display={card.phone}
              placeholder="+7…"
              onSaved={onFieldSaved}
            />
          )}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Telegram</dt>
        <dd className="font-medium">
          {readOnly ? (
            <span>
              {card.telegramUsername ? `@${card.telegramUsername}` : '—'}
            </span>
          ) : (
            <TextInlineEditor
              lead={card}
              field="telegram_username"
              label="Telegram (без @)"
              display={card.telegramUsername ? `@${card.telegramUsername}` : ''}
              placeholder="username"
              onSaved={onFieldSaved}
            />
          )}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Город</dt>
        <dd className="font-medium">
          {readOnly ? (
            <span>{card.city || '—'}</span>
          ) : (
            <CityInlineEditor lead={card} onSaved={onFieldSaved} />
          )}
        </dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="text-xs text-muted-foreground">Адрес</dt>
        <dd className="font-medium">
          {readOnly ? (
            <span>{card.address || '—'}</span>
          ) : (
            <TextInlineEditor
              lead={card}
              field="address"
              label="Адрес"
              display={card.address}
              placeholder="Улица, дом…"
              onSaved={onFieldSaved}
            />
          )}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Менеджер</dt>
        <dd className="font-medium">{card.managerName ?? '—'}</dd>
      </div>
      {variant === 'admin' || variant === 'head' ? (
        <div>
          <dt className="text-xs text-muted-foreground">Менеджер по кадрам</dt>
          <dd className="font-medium">{card.curatorName ?? '—'}</dd>
        </div>
      ) : null}
      <div>
        <dt className="text-xs text-muted-foreground">Передан</dt>
        <dd className="font-medium">
          {card.transferredAt ? formatDateTime(card.transferredAt) : '—'}
        </dd>
      </div>
    </dl>
  )
}
