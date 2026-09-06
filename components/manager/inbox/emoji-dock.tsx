'use client'

import { useEffect } from 'react'
import { Smile, Sticker, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { StickerItem } from '@/lib/types'
import { EmojiPanel, StickerPanel } from './pickers'

export type DockTab = 'emoji' | 'stickers'

/**
 * Правый док эмодзи/стикеров (Telegram-style). Заменяет всплывашку над
 * композером: клик по смайлику/стикеру раскрывает панель СПРАВА. Док
 * `fixed`-позиционируется у правого края (десктоп) или выезжает снизу
 * (мобайл) — так же, как «Карточка лида», и ВЗАИМОИСКЛЮЧИМ с ней: открытие
 * одного закрывает другое (координация через окно-события ниже). Панель
 * всегда смонтирована и только слайдится, чтобы переходы были плавными и не
 * дёргали раскладку.
 */
export function EmojiDock({
  open,
  tab,
  onTabChange,
  onClose,
  onPick,
  onSendSticker,
  channelId,
  stickersEnabled,
}: {
  open: boolean
  tab: DockTab
  onTabChange: (tab: DockTab) => void
  onClose: () => void
  onPick: (emoji: string) => void
  onSendSticker: (sticker: StickerItem) => void
  channelId: string
  stickersEnabled: boolean
}) {
  // Координация правых панелей: при открытии дока сообщаем миру «активна emoji»
  // — «Карточка лида» слушает это же событие и закрывается. Симметрично сам
  // док закрывается, когда открывается карточка (source !== 'emoji').
  useEffect(() => {
    if (!open) return
    window.dispatchEvent(
      new CustomEvent('omnidesk:right-panel-open', {
        detail: { source: 'emoji' },
      }),
    )
  }, [open])

  useEffect(() => {
    const onOther = (e: Event) => {
      const detail = (e as CustomEvent<{ source?: string }>).detail
      if (detail?.source && detail.source !== 'emoji') onClose()
    }
    window.addEventListener('omnidesk:right-panel-open', onOther)
    return () =>
      window.removeEventListener('omnidesk:right-panel-open', onOther)
  }, [onClose])

  // Тред сдвигается вправо на ширину дока, чтобы панель не перекрывала ленту
  // (тот же механизм, что у карточки лида — см. inbox-view).
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('omnidesk:emoji-dock-open', { detail: { open } }),
    )
  }, [open])

  // Esc закрывает док первым (capture + preventDefault), чтобы верхний
  // обработчик инбокса не закрыл заодно и сам диалог.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  return (
    <>
      {/* Mobile-only затемнение с плавным fade (десктоп оставляет диалог
          видимым и кликабельным рядом с доком). */}
      <button
        type="button"
        className={cn(
          'fixed inset-0 z-40 bg-black/30 transition-opacity duration-200 supports-backdrop-filter:backdrop-blur-[2px] sm:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        aria-label="Закрыть панель эмодзи"
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
        onClick={onClose}
      />

      <aside
        role="dialog"
        aria-label="Эмодзи и стикеры"
        aria-hidden={!open}
        className={cn(
          'fixed z-50 flex flex-col bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/10',
          'transition-transform duration-300 ease-out',
          // Mobile: bottom sheet.
          'max-sm:inset-x-0 max-sm:bottom-0 max-sm:h-[min(60dvh,26rem)] max-sm:rounded-t-2xl',
          open ? 'max-sm:translate-y-0' : 'max-sm:translate-y-full',
          // Desktop: правый док (уже, чем карточка лида).
          'sm:inset-y-0 sm:right-0 sm:w-[min(24rem,100vw)] sm:max-w-[24rem] sm:border-l sm:border-border',
          open ? 'sm:translate-x-0' : 'sm:translate-x-full',
          !open && 'pointer-events-none',
        )}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-2">
          {/* Сегменты Эмодзи / Стикеры */}
          <div className="flex items-center gap-1 rounded-full bg-muted p-0.5">
            <button
              type="button"
              onClick={() => onTabChange('emoji')}
              aria-pressed={tab === 'emoji'}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                tab === 'emoji'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Smile className="size-4" />
              Эмодзи
            </button>
            {stickersEnabled ? (
              <button
                type="button"
                onClick={() => onTabChange('stickers')}
                aria-pressed={tab === 'stickers'}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                  tab === 'stickers'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Sticker className="size-4" />
                Стикеры
              </button>
            ) : null}
          </div>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <X className="size-4" />
          </Button>
        </header>

        {/* Контент активной вкладки. Панели монтируются лениво (только когда
            док открыт), чтобы не тянуть стикеры/не строить сетку зря. */}
        <div className="min-h-0 flex-1">
          {open ? (
            tab === 'stickers' && stickersEnabled ? (
              <StickerPanel channelId={channelId} onSend={onSendSticker} />
            ) : (
              <EmojiPanel onPick={onPick} />
            )
          ) : null}
        </div>
      </aside>
    </>
  )
}
