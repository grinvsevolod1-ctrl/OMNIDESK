'use client'

import { useEffect, useTransition } from 'react'
import { Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import useSWR from 'swr'
import {
  getLeadCardDetailAction,
  returnLeadToFunnelAction,
  setLeadArchivedAction,
} from '@/app/actions/lead-cards'
import { LeadComments } from '@/components/curator/lead-detail/lead-comments'
import { LeadDetailFields } from '@/components/curator/lead-detail/lead-fields'
import { LeadHistory } from '@/components/curator/lead-detail/lead-history'
import { LeadIdentity } from '@/components/curator/lead-detail/lead-identity'
import { LeadLifecycleActions } from '@/components/curator/lead-detail/lead-lifecycle-actions'
import { PanelSection } from '@/components/curator/lead-detail/panel-section'
import { LeadStatusForm } from '@/components/curator/lead-panel-forms'
import { LeadAttachments } from '@/components/shared/lead-attachments'
import { Button } from '@/components/ui/button'
import { isFinalLeadStatus } from '@/lib/lead-status'
import { cn } from '@/lib/utils'

/**
 * Полная карточка лида (боковая панель). Используется менеджером по кадрам
 * и админом: variant='admin' переключает сохранение статуса на админский
 * action и показывает владельца-куратора в реквизитах.
 *
 * Файл — оркестратор: он владеет загрузкой (SWR), Esc-закрытием и действиями
 * жизненного цикла, а разметку блоков делегирует под-компонентам в ./lead-detail.
 */
export function LeadDetailPanel({
  leadId,
  onClose,
  onUpdated,
  variant = 'curator',
}: {
  leadId: string
  onClose: () => void
  onUpdated: () => void
  variant?: 'curator' | 'admin'
}) {
  const [pending, startTransition] = useTransition()

  const { data: detail, isLoading: loading, mutate } = useSWR(
    ['lead-detail', leadId],
    () => getLeadCardDetailAction(leadId),
    // keepPreviousData: при ревалидации после сохранения статуса панель не
    // мигает спиннером — старые данные видны, пока грузятся новые.
    { revalidateOnFocus: false, keepPreviousData: true },
  )
  const card = detail?.card ?? null
  const comments = detail?.comments ?? []
  const transfers = detail?.transfers ?? []
  const statusHistory = detail?.statusHistory ?? []

  // Esc закрывает карточку (кастомный оверлей — без встроенной обработки).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  /** После сохранения статуса: обновить панель и список снаружи. */
  function onStatusSaved() {
    onUpdated()
    void mutate()
  }

  /** После свободного комментария достаточно обновить панель. */
  function onCommentSaved() {
    void mutate()
  }

  /** После inline-правки поля: обновить панель и список снаружи. */
  function onFieldSaved() {
    onUpdated()
    void mutate()
  }

  function toggleArchive(archived: boolean) {
    startTransition(async () => {
      const res = await setLeadArchivedAction({ leadCardId: leadId, archived })
      if (res.ok) {
        toast.success(res.message)
        onUpdated()
        await mutate()
      } else {
        toast.error(res.message)
      }
    })
  }

  function returnToFunnel() {
    startTransition(async () => {
      const res = await returnLeadToFunnelAction({ leadCardId: leadId })
      if (res.ok) {
        toast.success(res.message)
        onUpdated()
        onClose()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-black/30 animate-in fade-in duration-200 supports-backdrop-filter:backdrop-blur-[2px]"
        aria-label="Закрыть"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative z-10 flex h-full w-full flex-col bg-popover shadow-2xl ring-1 ring-foreground/10',
          // Полный проезд от края + ease-out — то же плавное появление,
          // что и у docked-карточки в Inbox менеджера.
          'animate-in duration-300 ease-out max-sm:slide-in-from-bottom sm:slide-in-from-right',
          'max-sm:mt-auto max-sm:h-[min(94dvh,100%)] max-sm:rounded-t-2xl',
          'sm:w-[min(32rem,100vw)]',
        )}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3 sm:px-5">
          <p className="text-sm font-semibold">Карточка лида</p>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Закрыть">
            <X className="size-4" />
          </Button>
        </header>

        {loading || !card ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Загрузка…
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <PanelSection className="space-y-4">
              <LeadIdentity card={card} onFieldSaved={onFieldSaved} />
              <LeadDetailFields
                card={card}
                variant={variant}
                onFieldSaved={onFieldSaved}
              />
              <LeadHistory statusHistory={statusHistory} transfers={transfers} />
            </PanelSection>

            {/* Файлы: фото/видео. Кружки из диалога выбирает МЕНЕДЖЕР в своём
                инбоксе — менеджер по кадрам диалог не ведёт и содержимое
                переписки не просматривает, поэтому conversationId не передаём. */}
            <PanelSection>
              <LeadAttachments
                leadCardId={leadId}
                conversationId={null}
                attachments={detail?.attachments ?? []}
                onChanged={() => void mutate()}
              />
            </PanelSection>

            {/* Lifecycle: финальные лиды можно архивировать или вернуть ИИ. */}
            {isFinalLeadStatus(card.status) ? (
              <PanelSection className="space-y-2">
                <LeadLifecycleActions
                  card={card}
                  pending={pending}
                  onToggleArchive={toggleArchive}
                  onReturnToFunnel={returnToFunnel}
                />
              </PanelSection>
            ) : null}

            {/* Форма статуса — отдельный memo-компонент с собственным
                состоянием: ввод комментария не перерисовывает панель. */}
            <LeadStatusForm
              leadCardId={leadId}
              currentStatus={card.status}
              onSaved={onStatusSaved}
              variant={variant}
            />

            <PanelSection border={false} className="space-y-3">
              <LeadComments
                leadCardId={leadId}
                comments={comments}
                onCommentSaved={onCommentSaved}
              />
            </PanelSection>
          </div>
        )}
      </aside>
    </div>
  )
}
