import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Единый ритм секций карточки лида: одинаковые горизонтальные паддинги и
 * нижняя граница-разделитель. border={false} — для последней секции
 * (комментарии), чтобы не рисовать лишнюю линию у нижнего края.
 */
export function PanelSection({
  border = true,
  className,
  children,
}: {
  border?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'px-4 py-4 sm:px-5',
        border && 'border-b border-border',
        className,
      )}
    >
      {children}
    </div>
  )
}
