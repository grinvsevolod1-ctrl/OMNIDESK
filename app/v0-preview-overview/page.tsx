import { OverviewTab } from '@/components/admin/overview/overview-tab'
import type { SourceOverviewItem, SourcesOverview } from '@/lib/data/sources'

export const dynamic = 'force-dynamic'

/* ВРЕМЕННАЯ страница визуальной проверки Обзора (удаляется перед коммитом). */

function mk(
  id: string,
  name: string,
  people: number,
  types: string[],
): SourceOverviewItem {
  return {
    id,
    name,
    currency: 'USDT',
    createdAt: '2026-01-01',
    channels: types.map((t, i) => ({
      id: `${id}-c${i}`,
      name: `${t}-${i}`,
      type: t as SourceOverviewItem['channels'][number]['type'],
    })),
    stats: {
      people,
      handoff: Math.round(people * 0.6),
      liquid: Math.round(people * 0.35),
      transferred: Math.round(people * 0.2),
      income: people * 120,
      expense: people * 47.5,
      spark: Array.from({ length: 7 }, (_, i) =>
        Math.round(people * (0.05 + 0.13 * Math.abs(Math.sin(i + people)))),
      ),
    },
  }
}

const ALL: SourceOverviewItem[] = [
  mk('a', 'Яндекс Директ', 36, ['max', 'telegram']),
  mk('b', 'VK Реклама', 29, ['vk']),
  mk('c', 'Telegram Ads', 21, ['telegram', 'telegram']),
  mk('d', 'Посевы', 10, ['telegram']),
  mk('e', 'Сайт', 9, ['livechat']),
  mk('f', 'Авито', 4, ['whatsapp']),
  mk('g', 'Рассылка', 3, ['telegram']),
  mk('h', 'Партнёры', 2, ['vk', 'max']),
  mk('i', 'Оффлайн', 1, ['whatsapp']),
  mk('j', 'Блог', 1, ['livechat']),
  mk('k', 'YouTube', 5, ['telegram']),
  mk('l', 'Дзен', 2, ['max']),
]

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ n?: string }>
}) {
  const { n } = await searchParams
  const count = Math.max(1, Math.min(ALL.length, Number(n) || ALL.length))
  const overview: SourcesOverview = {
    from: '',
    to: '',
    items: ALL.slice(0, count),
    unassigned:
      count >= 4
        ? {
            channels: [{ id: 'x', name: 'Новый бот', type: 'telegram' }],
            stats: mk('x', '', 2, ['telegram']).stats,
          }
        : null,
  }
  return (
    <main className="mx-auto max-w-6xl p-6">
      <OverviewTab initialOverview={overview} groups={[]} channels={[]} />
    </main>
  )
}
