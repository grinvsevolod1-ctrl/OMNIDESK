import { describe, expect, it } from 'vitest'
import { mergeFreshSlice, mergeFreshSlices } from './merge-thread-slice'
import type { Message } from '@/lib/types'

function msg(id: string, minute: number, extra: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: 'c1',
    direction: 'in',
    body: `m-${id}`,
    author: 'Клиент',
    createdAt: new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString(),
    status: 'sent',
    ...extra,
  } as Message
}

describe('mergeFreshSlice', () => {
  it('keeps older history loaded on demand when the fresh slice is the newest tail', () => {
    // Reader loaded 100..109 on top of the preloaded 110..114; a refresh
    // re-ships only 110..114 (plus a brand-new 115).
    const local = Array.from({ length: 15 }, (_, i) => msg(`m${100 + i}`, i))
    const fresh = [...local.slice(10), msg('m115', 20)]
    const out = mergeFreshSlice(local, fresh)
    expect(out.map((m) => m.id)).toEqual([
      ...local.slice(0, 10).map((m) => m.id),
      'm110',
      'm111',
      'm112',
      'm113',
      'm114',
      'm115',
    ])
  })

  it('takes the fresh version of overlapping messages (edits, reactions, deletes)', () => {
    const local = [msg('a', 0), msg('b', 1, { body: 'old text' })]
    const fresh = [msg('b', 1, { body: 'edited text' })]
    const out = mergeFreshSlice(local, fresh)
    expect(out).toHaveLength(2)
    expect(out[1].body).toBe('edited text')
  })

  it('splits by position, so equal timestamps on the slice boundary keep the earlier message', () => {
    const local = [msg('x', 5), msg('y', 5), msg('z', 6)]
    const fresh = [msg('y', 5), msg('z', 6)]
    expect(mergeFreshSlice(local, fresh).map((m) => m.id)).toEqual(['x', 'y', 'z'])
  })

  it('drops optimistic tmp_ bubbles — the refresh carries the real row', () => {
    const local = [msg('a', 0), msg('tmp_1', 1, { direction: 'out' })]
    const fresh = [msg('a', 0), msg('real-1', 1, { direction: 'out' })]
    expect(mergeFreshSlice(local, fresh).map((m) => m.id)).toEqual(['a', 'real-1'])
  })

  it('drops a tmp_ bubble even when it sits in the older part', () => {
    const local = [msg('tmp_0', 0, { direction: 'out' }), msg('a', 1), msg('b', 2)]
    const fresh = [msg('b', 2)]
    expect(mergeFreshSlice(local, fresh).map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('falls back to timestamps when the cache and the slice are disjoint', () => {
    const local = [msg('old1', 0), msg('old2', 1), msg('stale', 30)]
    const fresh = [msg('n1', 10), msg('n2', 11)]
    // 'stale' is inside/after the fresh range but not in it → gone.
    expect(mergeFreshSlice(local, fresh).map((m) => m.id)).toEqual([
      'old1',
      'old2',
      'n1',
      'n2',
    ])
  })

  it('returns the fresh array itself when there is nothing older to keep', () => {
    const fresh = [msg('a', 0), msg('b', 1)]
    expect(mergeFreshSlice(undefined, fresh)).toBe(fresh)
    expect(mergeFreshSlice([], fresh)).toBe(fresh)
    expect(mergeFreshSlice([msg('a', 0)], fresh)).toBe(fresh)
  })

  it('an explicitly empty fresh slice wins (thread really is empty)', () => {
    expect(mergeFreshSlice([msg('a', 0)], [])).toEqual([])
  })
})

describe('mergeFreshSlices', () => {
  it('leaves threads absent from the fresh map untouched', () => {
    const hydrated = Array.from({ length: 5 }, (_, i) => msg(`h${i}`, i))
    const local = { c1: hydrated, c2: [msg('p', 0)] }
    const fresh = { c2: [msg('p', 0), msg('q', 1)] }
    const out = mergeFreshSlices(local, fresh)
    expect(out.c1).toBe(hydrated)
    expect(out.c2.map((m) => m.id)).toEqual(['p', 'q'])
  })
})
