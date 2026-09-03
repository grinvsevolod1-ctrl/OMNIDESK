import { requireCurator } from '@/lib/auth'
import {
  listConversationsForCurator,
  listCuratorLeadStatuses,
  listMessagesForConversationsCurator,
} from '@/lib/data/curator-conversations'
import { CuratorInbox } from '@/components/curator/chats/curator-inbox'

/**
 * «Чаты» куратора: переданные ему диалоги (миграция 151). SSR грузит список
 * диалогов и батч последних сообщений (как менеджерский инбокс), дальше
 * клиентский CuratorInbox догружает историю и слушает реалтайм по /api/stream.
 */
export default async function CuratorChatsPage() {
  const user = await requireCurator()
  const conversations = await listConversationsForCurator(user.sub)
  const conversationIds = conversations.map((c) => c.id)
  const [messagesByConversation, leadStatusByConversation] = await Promise.all([
    listMessagesForConversationsCurator(conversationIds, user.sub),
    listCuratorLeadStatuses(conversationIds, user.sub),
  ])

  return (
    // Полноэкранная страница (dashboard-shell отдаёт /curator/chats как
    // fullBleed): занимает всю высоту main без внешних полей и скролла.
    <div className="h-full">
      <CuratorInbox
        conversations={conversations}
        messagesByConversation={messagesByConversation}
        leadStatusByConversation={leadStatusByConversation}
        currentUser={user.name}
      />
    </div>
  )
}
