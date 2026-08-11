'use client'

import { memo } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** Номера страниц с многоточиями: 1 … 4 [5] 6 … 75 — рассчитано на 1500+ лидов. */
export const LeadsPagination = memo(function LeadsPagination({
  total,
  offset,
  pageSize,
  pending,
  onPage,
}: {
  total: number
  offset: number
  pageSize: number
  pending: boolean
  onPage: (offset: number) => void
}) {
  const pageCount = Math.ceil(total / pageSize)
  const current = Math.floor(offset / pageSize) + 1

  // Всегда: первая, последняя, текущая ± 1; между разрывами — многоточие.
  const pages: (number | 'gap')[] = []
  let prev = 0
  for (let p = 1; p <= pageCount; p++) {
    const keep = p === 1 || p === pageCount || Math.abs(p - current) <= 1
    if (!keep) continue
    if (prev && p - prev > 1) pages.push('gap')
    pages.push(p)
    prev = p
  }

  return (
    <nav
      className="flex flex-wrap items-center justify-center gap-1.5"
      aria-label="Страницы списка лидов"
    >
      <Button
        variant="outline"
        size="icon-sm"
        disabled={pending || current === 1}
        onClick={() => onPage((current - 2) * pageSize)}
        aria-label="Предыдущая страница"
      >
        <ChevronLeft className="size-4" />
      </Button>
      {pages.map((p, i) =>
        p === 'gap' ? (
          <span
            key={`gap-${i}`}
            className="px-1 text-sm text-muted-foreground"
            aria-hidden
          >
            …
          </span>
        ) : (
          <Button
            key={p}
            variant={p === current ? 'default' : 'outline'}
            size="icon-sm"
            disabled={pending}
            onClick={() => onPage((p - 1) * pageSize)}
            aria-label={`Страница ${p}`}
            aria-current={p === current ? 'page' : undefined}
          >
            {p}
          </Button>
        ),
      )}
      <Button
        variant="outline"
        size="icon-sm"
        disabled={pending || current === pageCount}
        onClick={() => onPage(current * pageSize)}
        aria-label="Следующая страница"
      >
        <ChevronRight className="size-4" />
      </Button>
      <span className="ml-2 text-xs text-muted-foreground">
        {offset + 1}–{Math.min(offset + pageSize, total)} из {total}
      </span>
    </nav>
  )
})
