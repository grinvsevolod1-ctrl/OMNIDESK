import type { Message } from '@/lib/types'

/**
 * Полный снимок диалога для выгрузки файлом (HTML / ZIP с медиа). Собирается
 * на сервере role-scoped экшеном (`app/actions/dialog-export.ts`), рендерится
 * в HTML чистой функцией `renderDialogHtml` и упаковывается в браузере.
 * Никаких server-only типов — файл общий для сервера, клиента и тестов.
 */
export interface DialogExportPayload {
  conversation: {
    id: string
    contactName: string
    contactUsername: string | null
    contactHandle: string
    channelType: string
    channelName: string | null
    /** Куратор, ведущий диалог (имя сотрудника). */
    curatorName: string | null
    /** Менеджер-владелец диалога (кто передал). */
    managerName: string | null
    transferredToCuratorAt: string | null
  }
  /** Вся история в хронологическом порядке (старые → новые). */
  messages: Message[]
  /** Обрезана ли история потолком выгрузки (см. EXPORT_MESSAGE_CAP). */
  truncated: boolean
  exportedAt: string
  exportedBy: { name: string; role: 'curator' | 'head' }
}

/** Ответ серверного экшена выгрузки. */
export type DialogExportResult =
  | { ok: true; data: DialogExportPayload }
  | { ok: false; message: string }
