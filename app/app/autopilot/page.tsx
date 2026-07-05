import { AutopilotManager } from '@/components/manager/autopilot-manager'
import { PageHeader } from '@/components/page-parts'
import {
  getAutopilotDataAction,
  getAutopilotSourcesAction,
} from '@/app/actions/autopilot'

export default async function AutopilotPage() {
  // Both loaders call requireManager() internally, so the page itself stays a
  // thin server shell — it just fetches the manager's master switch + rules and
  // the channels available as rule targets, then hands them to the client editor.
  const [data, sources] = await Promise.all([
    getAutopilotDataAction(),
    getAutopilotSourcesAction(),
  ])

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader
        title="Автопилот"
        description="Автоматические ответы на входящие сообщения по заданным правилам — приветствие новым клиентам, ответы по ключевым словам и напоминания, когда менеджер долго не отвечает."
      />
      <AutopilotManager
        initialEnabled={data.enabled}
        initialRules={data.rules}
        sources={sources}
      />
    </div>
  )
}
