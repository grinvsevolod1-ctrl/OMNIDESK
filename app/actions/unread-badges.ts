'use server'

/**
 * Живые бейджи непрочитанного для сайдбара. Каждый экшен под своим ролевым
 * гейтом и скоупит выборку по session.sub — счётчик всегда «мой» и совпадает
 * с одноимённым списком (инбокс менеджера / «Чаты» куратора).
 *
 * Экшены дёшевы (один count(*) по индексируемым колонкам), поэтому клиентский
 * бейдж может звать их на каждый push-сигнал `inbox` без нагрузки на БД.
 */
import { requireCurator, requireManager } from '@/lib/auth'
import { countUnreadConversationsForManager } from '@/lib/data'
import { countUnreadConversationsForCurator } from '@/lib/data/curator-conversations'

/** Число непрочитанных диалогов текущего менеджера. */
export async function getManagerUnreadCountAction(): Promise<number> {
  const user = await requireManager()
  return countUnreadConversationsForManager(user.sub)
}

/** Число непрочитанных диалогов текущего куратора. */
export async function getCuratorUnreadCountAction(): Promise<number> {
  const user = await requireCurator()
  return countUnreadConversationsForCurator(user.sub)
}
