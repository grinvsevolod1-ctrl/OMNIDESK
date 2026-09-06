/**
 * Один «передан» в инбоксе менеджера (миграция 161).
 *
 * Закрепляет правила, по которым статус «Передан» стал единственной точкой
 * входа к переданным диалогам, а системные статусы исчезли из ручного выбора:
 *   • без фильтра переданные скрыты, с «Передан» в фильтре видны все — и те,
 *     чью карточку куратор архивировал, и те, что менеджер убрал в trash;
 *   • писать можно только в возвращённые (rework/trash), пока куратор ведёт —
 *     только чтение;
 *   • «В работе» и «Передан» не предлагаются ни в статичных опциях, ни в
 *     опциях из словарей.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/manager/inbox/visual', () => ({
  sourceLabel: (c: { channelName?: string; channelId: string }) =>
    c.channelName ?? c.channelId,
}))

import {
  canManagerWrite,
  filterAndSortConversations,
  managerBucket,
  type FilterSortParams,
} from '@/components/manager/inbox/filtering'
import { buildLeadStatusOptions, DEFAULT_DICTIONARIES } from './dictionaries'
import {
  isSystemLeadStatus,
  LEAD_STATUS_OPTIONS,
  SELECTABLE_LEAD_STATUSES,
  type Conversation,
  type LeadStatus,
} from './types'

function conv(over: Partial<Conversation> & { id: string }): Conversation {
  return {
    channelId: 'ch-1',
    managerId: 'm-1',
    channelType: 'telegram',
    contactName: over.id,
    contactHandle: over.id,
    lastMessage: '',
    lastMessageAt: '2026-09-01T10:00:00.000Z',
    unread: 0,
    status: 'unsubscribed',
    statusManual: false,
    muted: false,
    contactBlocked: false,
    aiAutopilotEnabled: false,
    aiPaused: false,
    aiHandoffPending: false,
    ...over,
  } as Conversation
}

/** Диалог у куратора: статус пишет recordTransfer, curator_id стоит. */
function transferredConv(
  id: string,
  over: Partial<Conversation> = {},
): Conversation {
  return conv({
    id,
    status: 'transferred',
    statusManual: true,
    transferred: true,
    curatorName: 'Иванова',
    ...over,
  })
}

const active = conv({ id: 'active', status: 'liquid', statusManual: true })
const withCurator = transferredConv('with-curator', {
  curatorLeadStatus: 'working',
})
const returned = transferredConv('returned', { curatorLeadStatus: 'ignore' })
const archivedByCurator = transferredConv('archived', {
  curatorLeadStatus: 'working',
  curatorArchived: true,
})
const trashedByManager = transferredConv('trashed', {
  curatorLeadStatus: 'refused',
  curatorReworkTrashed: true,
})
const all = [active, withCurator, returned, archivedByCurator, trashedByManager]

function run(over: Partial<FilterSortParams> = {}): string[] {
  return filterAndSortConversations({
    conversations: all,
    search: '',
    typeFilter: new Set(),
    sourceFilter: new Set(),
    statusFilter: new Set<LeadStatus>(),
    reasonFilter: new Set(),
    sortMode: 'recent',
    awaitingReply: new Map(),
    isMuted: () => false,
    showMuted: false,
    viewBucket: 'active',
    activeId: null,
    localMessages: {},
    ...over,
  })
    .map((c) => c.id)
    .sort()
}

describe('managerBucket / canManagerWrite', () => {
  it('куратор ведёт → только чтение; вернулся или в trash → писать можно', () => {
    expect(managerBucket(active)).toBe('active')
    expect(managerBucket(withCurator)).toBe('transferred')
    expect(managerBucket(returned)).toBe('rework')
    expect(managerBucket(archivedByCurator)).toBe('rework')
    expect(managerBucket(trashedByManager)).toBe('archived')

    expect(canManagerWrite(active)).toBe(true)
    expect(canManagerWrite(withCurator)).toBe(false)
    expect(canManagerWrite(returned)).toBe(true)
    expect(canManagerWrite(archivedByCurator)).toBe(true)
    expect(canManagerWrite(trashedByManager)).toBe(true)
  })
})

describe('filterAndSortConversations: статус «Передан» — единственный вход', () => {
  it('без фильтра по статусу переданные скрыты', () => {
    expect(run()).toEqual(['active'])
  })

  it('«Передан» в фильтре показывает ВСЕ переданные — с куратором, вернувшиеся, архив, trash', () => {
    expect(run({ statusFilter: new Set<LeadStatus>(['transferred']) })).toEqual(
      ['archived', 'returned', 'trashed', 'with-curator'],
    )
  })

  it('«Передан» + другой статус: переданные плюс активные этого статуса', () => {
    expect(
      run({ statusFilter: new Set<LeadStatus>(['transferred', 'liquid']) }),
    ).toEqual(['active', 'archived', 'returned', 'trashed', 'with-curator'])
  })

  it('другой статус без «Передан» переданных не раскрывает', () => {
    expect(run({ statusFilter: new Set<LeadStatus>(['liquid']) })).toEqual([
      'active',
    ])
  })

  it('«Доработки» — только вернувшиеся, без trash и без тех, что у куратора', () => {
    expect(run({ viewBucket: 'rework' })).toEqual(['archived', 'returned'])
  })

  it('открытый диалог не исчезает из списка, даже если фильтр его не пропускает', () => {
    expect(run({ activeId: 'with-curator' })).toEqual([
      'active',
      'with-curator',
    ])
  })
})

describe('системные статусы не выбираются вручную', () => {
  it('handoff и transferred системные, остальные — нет', () => {
    expect(isSystemLeadStatus('handoff')).toBe(true)
    expect(isSystemLeadStatus('transferred')).toBe(true)
    expect(isSystemLeadStatus('liquid')).toBe(false)
    expect(isSystemLeadStatus(null)).toBe(false)
    expect(SELECTABLE_LEAD_STATUSES).toEqual([
      'unsubscribed',
      'liquid',
      'not_liquid',
    ])
  })

  it('ни статичные опции, ни опции из словарей не содержат системных статусов', () => {
    const fromDict = buildLeadStatusOptions(DEFAULT_DICTIONARIES)
    for (const opts of [LEAD_STATUS_OPTIONS, fromDict]) {
      expect(opts.some((o) => isSystemLeadStatus(o.status))).toBe(false)
      // «Не ликвид» по-прежнему раскрыт на четыре причины.
      expect(opts.filter((o) => o.status === 'not_liquid')).toHaveLength(4)
    }
    expect(fromDict.map((o) => o.value)).toEqual(
      LEAD_STATUS_OPTIONS.map((o) => o.value),
    )
  })
})
