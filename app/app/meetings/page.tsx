import { requireManager } from '@/lib/auth'
import { listTelemostMeetings } from '@/lib/data'
import { isTelemostConfigured } from '@/lib/telemost'
import { MeetingsView } from '@/components/manager/meetings-view'

export const metadata = {
  title: 'Видеовстречи — OMNIDESK',
  description: 'Яндекс Телемост: создавайте встречи и делитесь ссылками.',
}

export default async function MeetingsPage() {
  const session = await requireManager()

  const [meetings, telemostEnabled] = await Promise.all([
    listTelemostMeetings(session.sub, 30),
    isTelemostConfigured(),
  ])

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6">
      <MeetingsView meetings={meetings} telemostEnabled={telemostEnabled} />
    </div>
  )
}
