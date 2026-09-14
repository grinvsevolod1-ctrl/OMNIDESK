'use client'

import { useEffect } from 'react'
import { toast } from 'sonner'
import { onStreamEvent } from '@/lib/hooks/realtime-stream'

/**
 * Живой toast «вам передали лид» для куратора.
 *
 * Слушает общий SSE-кадр `lead`. Обычный кадр несёт только `id` (пинок на
 * рефетч списка) — на него мы не реагируем. Семантический `leadKind:
 * 'transferred'` SSE-роут прикрепляет ТОЛЬКО целевому получателю (см.
 * app/api/stream), поэтому здесь не нужна дополнительная фильтрация по
 * curatorId: если поле пришло — оно адресовано этой вкладке. Web-push
 * (notifyCuratorOfTransfer) покрывает закрытую вкладку; этот тост — для
 * открытой, чтобы куратор увидел передачу мгновенно, не перезагружая раздел.
 *
 * Рендерит null — только сайд-эффект подписки. Монтируется в разделах
 * куратора, где уже открыт общий EventSource.
 */
export function LeadTransferToaster() {
  useEffect(() => {
    return onStreamEvent('lead', (data) => {
      if (!data || typeof data !== 'object') return
      const evt = data as { leadKind?: string; leadName?: string | null }
      if (evt.leadKind !== 'transferred') return
      const name = evt.leadName?.trim()
      toast.info('Вам передан лид', {
        description: name
          ? `${name}. Подтвердите статус в разделе «Лиды».`
          : 'Подтвердите статус в разделе «Лиды».',
      })
    })
  }, [])

  return null
}
