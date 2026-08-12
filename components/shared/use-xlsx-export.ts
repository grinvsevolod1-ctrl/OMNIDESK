'use client'

/**
 * Общий клиентский флоу Excel-выгрузки для всех трёх списков лидов
 * (админ / менеджер / менеджер по кадрам): server action собирает .xlsx
 * и возвращает base64 (стримить файл из action нельзя) — хук скачивает
 * его через Blob и показывает toast. Раньше этот код был скопирован
 * в трёх компонентах — теперь единственная реализация здесь.
 */

import { useCallback, useTransition } from 'react'
import { toast } from 'sonner'
import { downloadBase64Xlsx } from '@/components/admin/leads/xlsx-download'

/** Единая форма ответа всех export*ExcelAction. */
export interface XlsxExportResult {
  ok: boolean
  base64?: string
  fileName?: string
  rows?: number
  message?: string
}

export function useXlsxExport(): {
  exporting: boolean
  runExport: (fetcher: () => Promise<XlsxExportResult>) => void
} {
  const [exporting, startExport] = useTransition()

  const runExport = useCallback(
    (fetcher: () => Promise<XlsxExportResult>) => {
      startExport(async () => {
        const res = await fetcher()
        if (res.ok && res.base64 && res.fileName) {
          downloadBase64Xlsx(res.base64, res.fileName)
          toast.success(`Выгружено лидов: ${res.rows ?? 0}`)
        } else {
          toast.error(res.message ?? 'Ошибка выгрузки')
        }
      })
    },
    [],
  )

  return { exporting, runExport }
}
