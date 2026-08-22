'use client'

import { useMemo, useState, useTransition } from 'react'
import { SearchX } from 'lucide-react'
import { toast } from 'sonner'
import useSWR from 'swr'
import {
  getLeadCardDetailAction,
  returnLeadToFunnelAction,
  setLeadArchivedAction,
} from '@/app/actions/lead-cards'
import { ArchiveLeadDialog } from '@/components/curator/archive-lead-dialog'
import { LeadComments } from '@/components/curator/lead-detail/lead-comments'
import { LeadDetailFields } from '@/components/curator/lead-detail/lead-fields'
import { LeadHistory } from '@/components/curator/lead-detail/lead-history'
import { LeadIdentity } from '@/components/curator/lead-detail/lead-identity'
import { LeadLifecycleActions } from '@/components/curator/lead-detail/lead-lifecycle-actions'
import { LeadTransferSection } from '@/components/curator/lead-detail/lead-transfer-section'
import { PanelSection } from '@/components/curator/lead-detail/panel-section'
import { LeadStatusForm } from '@/components/curator/lead-panel-forms'
import { LeadAttachments } from '@/components/shared/lead-attachments'
import {
  SlideOver,
  SlideOverSectionSkeleton,
} from '@/components/shared/slide-over'
import type { LeadCard } from '@/lib/data/lead-cards'

type LeadCardDetail = NonNullable<
  Awaited<ReturnType<typeof getLeadCardDetailAction>>
>

/** Частичная деталь из строки списка: карточка есть сразу, остальное грузится. */
type PartialDetail = LeadCardDetail & { partial?: true }

/**
 * Полная карточка лида (боковая панель). Используется менеджером по кадрам
 * и админом: variant='admin' переключает сохранение статуса на админский
 * action и показывает владельца-куратора в реквизитах.
 *
 * Скорость открытия: панель всегда смонтирована (SlideOver, transform-only
 * анимация), а данные карточки берутся мгновенно из строки списка
 * (fallbackLead) — сеть догружает только комментарии/историю/вложения,
 * их секции показывают лёгкие скелетоны вместо глобального спиннера.
 */
export function LeadDetailPanel({
  leadId,
  fallbackLead,
  onClose,
  onUpdated,
  variant = 'curator',
  headCanEdit = false,
}: {
  leadId: string | null
  /** Карточка из строки списка — рендерится мгновенно, без ожидания сети. */
  fallbackLead?: LeadCard | null
  onClose: () => void
  onUpdated: () => void
  variant?: 'curator' | 'admin' | 'head'
  /** Право руководителя «просмотр и редактирование» (variant='head'). */
  headCanEdit?: boolean
}) {
  // Руководитель «только просмотр»: вся панель в режиме чтения.
  const readOnly = variant === 'head' && !headCanEdit
  const [pending, startTransition] = useTransition()
  // Диалог «Перенос в архив»: причина + обязательный комментарий.
  const [archiveOpen, setArchiveOpen] = useState(false)

  // Держим последний открытый id, чтобы контент оставался видимым во время
  // анимации закрытия (leadId уже null, панель ещё уезжает).
  const [lastId, setLastId] = useState(leadId)
  if (leadId && leadId !== lastId) setLastId(leadId)
  const activeId = leadId ?? lastId

  // Мгновенный первый кадр: ~90% полей уже есть в строке, по которой кликнули.
  const fallbackDetail = useMemo<PartialDetail | undefined>(
    () =>
      fallbackLead && fallbackLead.id === activeId
        ? {
            card: fallbackLead,
            comments: [],
            transfers: [],
            statusHistory: [],
            attachments: [],
            // До гидратации авторство неизвестно — правка комментов недоступна.
            viewerId: '',
            partial: true,
          }
        : undefined,
    [fallbackLead, activeId],
  )

  const { data, isLoading, mutate } = useSWR<PartialDetail | null>(
    activeId ? ['lead-detail', activeId] : null,
    () => getLeadCardDetailAction(activeId as string),
    { revalidateOnFocus: false, fallbackData: fallbackDetail },
  )
  const detail = data ?? null
  const card = detail?.card ?? null
  // Пока пришла только частичная деталь из списка — секции сети в скелетонах.
  const hydrating = !detail || detail.partial === true

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

  /** Возврат из архива (перенос В архив — только через диалог с причиной). */
  function unarchive() {
    if (!activeId) return
    startTransition(async () => {
      const res = await setLeadArchivedAction({
        leadCardId: activeId,
        archived: false,
      })
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
    if (!activeId) return
    startTransition(async () => {
      const res = await returnLeadToFunnelAction({ leadCardId: activeId })
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
    <SlideOver open={leadId !== null} onClose={onClose} title="Карточка лида">
      {!card ? (
        isLoading ? (
          <div className="flex flex-1 flex-col gap-4 px-4 py-4 sm:px-5">
            <SlideOverSectionSkeleton rows={3} />
            <SlideOverSectionSkeleton rows={2} />
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <SearchX className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">Лид не найден</p>
            <p className="text-xs text-muted-foreground">
              Карточка была удалена или у вас больше нет к ней доступа.
            </p>
          </div>
        )
      ) : (
        <div
          // Ключ по id: смена лида полностью сбрасывает локальное состояние форм.
          key={card.id}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
        >
          <PanelSection className="space-y-4">
            <LeadIdentity
              card={card}
              onFieldSaved={onFieldSaved}
              readOnly={readOnly}
            />
            <LeadDetailFields
              card={card}
              variant={variant}
              onFieldSaved={onFieldSaved}
              readOnly={readOnly}
            />
            {hydrating ? (
              <SlideOverSectionSkeleton rows={2} />
            ) : (
              <LeadHistory
                statusHistory={detail?.statusHistory ?? []}
                transfers={detail?.transfers ?? []}
              />
            )}
          </PanelSection>

          {/* Файлы: фото/видео. Кружки из диалога выбирает МЕНЕДЖЕР в своём
              инбоксе — менеджер по кадрам диалог не ведёт и содержимое
              переписки не просматривает, поэтому conversationId не передаём. */}
          <PanelSection>
            {hydrating ? (
              <SlideOverSectionSkeleton rows={1} />
            ) : (
              <LeadAttachments
                leadCardId={card.id}
                conversationId={null}
                attachments={detail?.attachments ?? []}
                onChanged={() => void mutate()}
                readOnly={readOnly}
              />
            )}
          </PanelSection>

          {/* Передача коллеге: кураторская панель и руководитель с правом
              «редактирование» (внутри своей группы), пока лид не в архиве —
              из архива сначала верните лид. */}
          {(variant === 'curator' || (variant === 'head' && headCanEdit)) &&
          !card.archivedAt ? (
            <PanelSection>
              <LeadTransferSection
                leadCardId={card.id}
                currentCuratorId={card.curatorId}
                variant={variant}
                onTransferred={() => {
                  onUpdated()
                  onClose()
                }}
              />
            </PanelSection>
          ) : null}

          {/* Lifecycle: «В архив» доступна с любого статуса (через диалог
              с причиной и комментарием). Руководителю недоступно даже
              с правом редактирования. */}
          {variant !== 'head' ? (
            <PanelSection className="space-y-2">
              <LeadLifecycleActions
                card={card}
                pending={pending}
                onRequestArchive={() => setArchiveOpen(true)}
                onUnarchive={unarchive}
                onReturnToFunnel={returnToFunnel}
              />
            </PanelSection>
          ) : null}

          {/* Форма статуса — отдельный memo-компонент с собственным
              состоянием: ввод комментария не перерисовывает панель.
              В readOnly-режиме статус менять нельзя. */}
          {readOnly ? null : (
            <LeadStatusForm
              leadCardId={card.id}
              currentStatus={card.status}
              onSaved={onStatusSaved}
              variant={variant}
            />
          )}

          <PanelSection border={false} className="space-y-3">
            {hydrating ? (
              <SlideOverSectionSkeleton rows={2} />
            ) : (
              <LeadComments
                leadCardId={card.id}
                comments={detail?.comments ?? []}
                onCommentSaved={onCommentSaved}
                readOnly={readOnly}
                viewerId={detail?.viewerId ?? null}
              />
            )}
          </PanelSection>

          <ArchiveLeadDialog
            leadCardId={card.id}
            leadName={card.fullName}
            open={archiveOpen}
            onOpenChange={setArchiveOpen}
            onArchived={() => {
              onUpdated()
              void mutate()
            }}
          />
        </div>
      )}
    </SlideOver>
  )
}
