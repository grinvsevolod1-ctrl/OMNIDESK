import { PageHeader } from '@/components/page-parts'
import { AiConsole } from '@/components/admin/ai-console'
import { requireAdmin } from '@/lib/auth'
import { isBrainConfigured } from '@/lib/ai/manager-brain'
import {
  countLessons,
  getAiAssistSettings,
  listLessons,
} from '@/lib/data/ai-assist'

export const dynamic = 'force-dynamic'

export default async function AiAssistPage() {
  await requireAdmin()
  const [settings, lessons, lessonCount] = await Promise.all([
    getAiAssistSettings(),
    listLessons(100),
    countLessons(),
  ])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="ИИ-ассистент"
        description="Обучаемый продавец, который ведёт переписку с клиентами вместо менеджера. Просто напишите, что нужно сделать — консоль поймёт и откроет нужный раздел."
      />
      <AiConsole
        initialSettings={settings}
        initialLessons={lessons}
        initialLessonCount={lessonCount}
        configured={isBrainConfigured()}
      />
    </div>
  )
}
