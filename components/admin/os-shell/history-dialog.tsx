'use client'

/** История диалогов OS-шелла: прошлые сессии, заархивированные «Новый диалог». */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ConsoleSessionArchiveItem } from '@/lib/data/console-shell'
import { formatArchiveDate } from './shell-helpers'

export function ShellHistoryDialog({
  open,
  onOpenChange,
  items,
  onRestore,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: ConsoleSessionArchiveItem[] | null
  onRestore: (archiveId: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>История диалогов</DialogTitle>
        </DialogHeader>
        {items === null ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Загружаю…
          </p>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Пока пусто — прошлые диалоги появятся здесь после «Новый диалог».
          </p>
        ) : (
          <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onRestore(item.id)}
                  className="w-full rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent"
                >
                  <span className="block truncate text-sm font-medium">
                    {item.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {formatArchiveDate(item.createdAt)} · сообщений:{' '}
                    {item.turnCount}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
