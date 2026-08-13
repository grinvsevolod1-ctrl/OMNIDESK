'use client'

import { ClipboardList, Loader2, Send, X } from 'lucide-react'
import { LeadAttachments } from '@/components/shared/lead-attachments'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { LeadCardForm } from './lead-card/lead-card-form'
import { LeadCardDetails } from './lead-card/lead-card-details'
import { useLeadCard, type LeadCardDefaults } from './lead-card/use-lead-card'

/**
 * «Карточка лида» — кнопка рядом с ИИ.
 * Открывает фиксированную панель, прикреплённую к краю экрана до закрытия
 * (не уезжает при скролле диалога). На мобиле — почти full-width снизу,
 * на десктопе — широкая правая колонка.
 *
 * Контейнер-разметка; состояние и логика — lead-card/use-lead-card.ts,
 * поля формы — lead-card/lead-card-form.tsx, секции сохранённой карточки —
 * lead-card/lead-card-details.tsx.
 */
export function LeadCardPanel({
  conversationId,
  defaults,
  onBrowseMedia,
}: {
  conversationId: string
  defaults?: LeadCardDefaults
  /** Телеграм-стиль навигация по кружкам/фото диалога для прикрепления. */
  onBrowseMedia?: (kind: 'video_note' | 'photo', leadCardId: string) => void
}) {
  const state = useLeadCard(conversationId, defaults)
  const {
    open,
    setOpen,
    toggleOpen,
    pending,
    cardId,
    detail,
    mutateDetail,
    transferredAt,
    curatorId,
    save,
    ensureCardId,
  } = state

  return (
    <>
      <Button
        variant={transferredAt ? 'default' : 'ghost'}
        size="sm"
        className="gap-1.5"
        title="Карточка лида"
        aria-label="Карточка лида"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        <ClipboardList className="size-4" />
        <span className="hidden sm:inline">Карточка</span>
      </Button>

      {/* Mobile-only dim backdrop with a smooth fade (desktop keeps the
          dialog fully visible and clickable next to the docked panel). */}
      <button
        type="button"
        className={cn(
          'fixed inset-0 z-40 bg-black/30 transition-opacity duration-200 supports-backdrop-filter:backdrop-blur-[2px] sm:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        aria-label="Закрыть карточку"
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
        onClick={() => setOpen(false)}
      />

      {/* Always-mounted panel sliding in/out with the same smooth
          transition-transform the «О контакте» drawer uses. Docked to the
          right edge on desktop so the dialog stays readable beside it. */}
      <aside
        role="dialog"
        aria-label="Карточка лида"
        aria-hidden={!open}
        className={cn(
          'fixed z-50 flex flex-col bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/10',
          'transition-transform duration-300 ease-out',
          // Mobile: bottom sheet sliding up.
          'max-sm:inset-x-0 max-sm:bottom-0 max-sm:h-[min(92dvh,100dvh)] max-sm:rounded-t-2xl',
          open ? 'max-sm:translate-y-0' : 'max-sm:translate-y-full',
          // Desktop: right-docked column sliding in.
          'sm:inset-y-0 sm:right-0 sm:w-[min(28rem,100vw)] sm:max-w-[28rem] sm:border-l sm:border-border',
          open ? 'sm:translate-x-0' : 'sm:translate-x-full',
          !open && 'pointer-events-none',
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <p className="text-base font-semibold tracking-tight">
              Карточка лида
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Данные для передачи менеджеру по кадрам
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setOpen(false)}
            aria-label="Закрыть"
          >
            <X className="size-4" />
          </Button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          <LeadCardForm state={state} />

          {transferredAt ? (
            <p className="rounded-lg bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-700 dark:text-emerald-400">
              Передано{' '}
              {new Date(transferredAt).toLocaleString('ru-RU', {
                dateStyle: 'short',
                timeStyle: 'short',
              })}
            </p>
          ) : null}

          {/* Файлы: доступны СРАЗУ (карточка сохранится тихо при первом
              прикреплении). Кружки/фото выбираются навигацией по треду. */}
          <div className="border-t border-border pt-3.5">
            <LeadAttachments
              leadCardId={cardId}
              ensureCardId={ensureCardId}
              conversationId={conversationId}
              attachments={detail?.attachments ?? []}
              onChanged={() => void mutateDetail()}
              onBrowseMedia={
                onBrowseMedia
                  ? async (kind) => {
                      const id = await ensureCardId()
                      if (id) onBrowseMedia(kind, id)
                    }
                  : undefined
              }
            />
          </div>

          {cardId ? (
            <LeadCardDetails state={state} />
          ) : (
            <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
              Комментарии станут доступны после сохранения карточки.
              Файлы, кружки и фото можно прикреплять сразу — карточка
              сохранится автоматически.
            </p>
          )}
        </div>

        <footer className="flex shrink-0 gap-2 border-t border-border bg-muted/30 p-3 sm:p-4">
          <Button
            variant="outline"
            className="flex-1"
            disabled={pending}
            onClick={() => save(false)}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Сохранить
          </Button>
          <Button
            className="flex-1 gap-1.5"
            disabled={pending || !curatorId}
            onClick={() => save(true)}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Передать
          </Button>
        </footer>
      </aside>
    </>
  )
}
