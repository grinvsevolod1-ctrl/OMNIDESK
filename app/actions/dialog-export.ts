'use server'

import { getSession } from '@/lib/auth'
import { writeAudit } from '@/lib/data/audit'
import { getConversationForCurator } from '@/lib/data/curator-conversations'
import { listAllMessagesForExport } from '@/lib/data/dialog-export'
import { getConversationForHead } from '@/lib/data/head-conversations'
import type { DialogExportResult } from '@/lib/dialog-export/types'
import type { Conversation } from '@/lib/types'

/**
 * Снимок диалога для выгрузки файлом (HTML / ZIP с медиа).
 *
 * Одна точка входа для двух ролей — право доступа решает role-scoped getter:
 *   - куратор: только переданные ЕМУ диалоги (conversations.curator_id);
 *   - руководитель: диалоги кураторов его команд(ы).
 * Остальным ролям выгрузка недоступна (менеджеру/админу — в их разделах
 * этой кнопки нет). Полная история читается unscoped ТОЛЬКО после того, как
 * getter подтвердил владение. Медиа клиент докачивает сам через
 * `/api/media/{id}` — там свой owner-гейт по той же роли.
 */
export async function exportDialogAction(
  conversationId: string,
): Promise<DialogExportResult> {
  const session = await getSession()
  if (!session) return { ok: false, message: 'Сессия истекла.' }
  if (!conversationId) return { ok: false, message: 'Диалог не указан.' }

  let conv: Conversation | null = null
  let role: 'curator' | 'head'
  if (session.role === 'curator') {
    role = 'curator'
    conv = await getConversationForCurator(conversationId, session.sub)
  } else if (session.role === 'head') {
    role = 'head'
    conv = await getConversationForHead(conversationId, session.sub)
  } else {
    return { ok: false, message: 'Выгрузка недоступна для вашей роли.' }
  }
  if (!conv) return { ok: false, message: 'Диалог не найден.' }

  const { messages, truncated } = await listAllMessagesForExport(conv.id)

  // Журнал: кто и какой диалог выгрузил (fire-and-forget, никогда не кидает).
  void writeAudit({
    actorRole: role,
    actorId: session.sub,
    actorLabel: `${session.name} (${role === 'head' ? 'руководитель' : 'менеджер по кадрам'})`,
    action: 'dialog.export',
    entityType: 'conversation',
    entityId: conv.id,
    details: { messages: messages.length, truncated },
  })

  return {
    ok: true,
    data: {
      conversation: {
        id: conv.id,
        contactName: conv.contactName,
        contactUsername: conv.contactUsername ?? null,
        contactHandle: conv.contactHandle,
        channelType: conv.channelType,
        channelName: conv.channelName ?? null,
        curatorName: conv.curatorName ?? (role === 'curator' ? session.name : null),
        managerName: conv.managerName ?? null,
        transferredToCuratorAt: conv.transferredToCuratorAt ?? null,
      },
      messages,
      truncated,
      exportedAt: new Date().toISOString(),
      exportedBy: { name: session.name, role },
    },
  }
}
