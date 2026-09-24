import { requireHead } from '@/lib/auth'
import { listCuratorsOfHead } from '@/lib/data/heads'
import {
  listConversationsForHead,
  listMessagesForConversationsHead,
} from '@/lib/data/head-conversations'
import { HeadChats, type HeadChatCurator } from '@/components/head/chats/head-chats'

/**
 * Сколько самых свежих тредов предзагружать на SSR. Остальные гидрируются
 * лениво при открытии (useThreadHistory → loadHeadThreadMessagesAction).
 * Этот payload уезжает на КАЖДЫЙ router.refresh() по realtime-тику — как в
 * инбоксе менеджера (INBOX_PRELOAD_THREADS), не раздувай.
 */
const HEAD_PRELOAD_THREADS = 15

/**
 * «Диалоги» руководителя: переписка кураторов его команд(ы) с кандидатами,
 * только просмотр. SSR грузит кураторов, список диалогов (свежие сверху) и
 * батч последних сообщений первых тредов; дальше клиент слушает /api/stream.
 */
export default async function HeadChatsPage() {
  const user = await requireHead()
  const [curatorRows, conversations] = await Promise.all([
    listCuratorsOfHead(user.sub),
    listConversationsForHead(user.sub),
  ])
  const preloadIds = conversations
    .slice(0, HEAD_PRELOAD_THREADS)
    .map((c) => c.id)
  const messagesByConversation = await listMessagesForConversationsHead(
    preloadIds,
    user.sub,
  )

  const dialogsByCurator = new Map<string, number>()
  for (const c of conversations) {
    if (!c.curatorId) continue
    dialogsByCurator.set(c.curatorId, (dialogsByCurator.get(c.curatorId) ?? 0) + 1)
  }
  const curators: HeadChatCurator[] = curatorRows.map((c) => ({
    id: c.id,
    name: c.name,
    dialogs: dialogsByCurator.get(c.id) ?? 0,
  }))

  return (
    // Полноэкранная страница (dashboard-shell отдаёт /head/chats как fullBleed).
    <div className="h-full">
      <HeadChats
        curators={curators}
        conversations={conversations}
        messagesByConversation={messagesByConversation}
        currentUser={user.name}
      />
    </div>
  )
}
