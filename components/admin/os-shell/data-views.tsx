'use client'

/**
 * Structured data panels for the OMNIDESK OS shell: the copilot SHOWS data
 * (metric cards, tables) instead of dumping numbers into prose. Each panel is
 * defensive about its payload shape — the payload crosses an SSE boundary, so
 * we validate at the edges and render nothing rather than crash the feed.
 *
 * This file is only the kind→panel dispatcher; the panels themselves live in
 * ./data-views/* grouped by domain (servers, dialogs, AI, organisation).
 */

import type { DataView } from '@/lib/admin-console/assistant'
import {
  DirectivesPanel,
  KnowledgePanel,
  SchedulesPanel,
} from './data-views/ai-panels'
import {
  DialogsPanel,
  ManagerActivityPanel,
  MessagesPanel,
} from './data-views/dialogs-panels'
import {
  ChannelsPanel,
  ContactsPanel,
  DictionariesPanel,
  FinancePanel,
  ManagersPanel,
  ProxiesPanel,
  StatsPanel,
} from './data-views/org-panels'
import { AppsPanel, ServersPanel } from './data-views/servers-panels'

export function DataViewPanel({
  view,
  onCommand,
}: {
  view: DataView
  /** Row clicks drill down by issuing a follow-up command to the copilot. */
  onCommand?: (prompt: string) => void
}) {
  const body = renderBody(view, onCommand)
  if (!body) return null
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card/60 backdrop-blur-sm duration-300 animate-in fade-in slide-in-from-bottom-2">
      <h3 className="border-b border-border px-3.5 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {view.title}
      </h3>
      <div className="p-3.5">{body}</div>
    </section>
  )
}

function renderBody(view: DataView, onCommand?: (prompt: string) => void) {
  switch (view.kind) {
    case 'stats':
      return <StatsPanel payload={view.payload} />
    case 'managers':
      return <ManagersPanel payload={view.payload} onCommand={onCommand} />
    case 'channels':
      return <ChannelsPanel payload={view.payload} />
    case 'proxies':
      return <ProxiesPanel payload={view.payload} />
    case 'contacts':
      return <ContactsPanel payload={view.payload} />
    case 'finance':
      return <FinancePanel payload={view.payload} />
    case 'dictionaries':
      return <DictionariesPanel payload={view.payload} />
    case 'schedules':
      return <SchedulesPanel payload={view.payload} />
    case 'dialogs':
      return <DialogsPanel payload={view.payload} onCommand={onCommand} />
    case 'messages':
      return <MessagesPanel payload={view.payload} />
    case 'manager_activity':
      return (
        <ManagerActivityPanel payload={view.payload} onCommand={onCommand} />
      )
    case 'directives':
      return <DirectivesPanel payload={view.payload} />
    case 'knowledge':
      return <KnowledgePanel payload={view.payload} />
    case 'servers':
      return <ServersPanel payload={view.payload} onCommand={onCommand} />
    case 'apps':
      return <AppsPanel payload={view.payload} onCommand={onCommand} />
    default:
      return null
  }
}
