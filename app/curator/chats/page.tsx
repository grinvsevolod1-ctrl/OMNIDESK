import { requireCurator } from '@/lib/auth'
import {
  listConversationsForCurator,
  listMessagesForConversationsCurator,
} from '@/lib/data/curator-conversations'
import { PageHeader } from '@/components/page-parts'
import { CuratorInbox } from '@/components/curator/chats/curator-inbox'

/**
 * «Чаты» куратора: переданные ему диалоги (миграция 151). SSR грузит список
 * диалогов и батч последних сообщений (как менеджерский инбокс), дальше
 * клиентский CuratorInbox догружает историю и слушает реалтайм по /api/stream.
 */
export default async function CuratorChatsPage() {
  const user = await requireCurator()
  const conversations = await listConversationsForCurator(user.sub)
  const messagesByConversation = await listMessagesForConversationsCurator(
    conversations.map((c) => c.id),
    user.sub,
  )

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Чаты"
        description="Переписка по переданным вам лидам. Отвечайте клиентам прямо здесь — текстом или вложением."
      />
      <CuratorInbox
        conversations={conversations}
        messagesByConversation={messagesByConversation}
        currentUser={user.name}
      />
    </div>
  )
}
