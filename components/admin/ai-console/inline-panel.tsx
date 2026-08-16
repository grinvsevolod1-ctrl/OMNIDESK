'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { Check, Loader2, ShieldAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import type { AiAssistLesson, AiAssistSettings } from '@/lib/data/ai-assist'
import { INTENT_BY_ID, type ConsoleIntent } from '@/lib/ai-console/intents'
import { PANEL_ICON } from './chat-types'

// Heavier, less-frequently opened panels load on demand — the console's initial
// chunk stays lean (just the composer + settings/training).
const panelLoading = () => (
  <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
    <Loader2 className="mr-2 size-4 animate-spin" />
    Загрузка…
  </div>
)
const AiEnrollmentTab = dynamic(
  () =>
    import('@/components/admin/ai-enrollment-tab').then((m) => m.AiEnrollmentTab),
  { loading: panelLoading },
)
const AiCorrectionsTab = dynamic(
  () =>
    import('@/components/admin/ai-corrections-tab').then(
      (m) => m.AiCorrectionsTab,
    ),
  { loading: panelLoading },
)
const AiLogsTab = dynamic(
  () => import('@/components/admin/ai-logs-tab').then((m) => m.AiLogsTab),
  { loading: panelLoading },
)
const KnowledgeBaseCard = dynamic(
  () =>
    import('@/components/admin/ai-settings-tab').then((m) => m.KnowledgeBaseCard),
  { loading: panelLoading },
)
// Settings and training panels also only appear when the assistant opens them,
// so they don't belong in the initial chunk either (~1200 lines combined).
const SettingsTab = dynamic(
  () => import('@/components/admin/ai-settings-tab').then((m) => m.SettingsTab),
  { loading: panelLoading },
)
const TrainingTab = dynamic(
  () => import('@/components/admin/ai-training-tab').then((m) => m.TrainingTab),
  { loading: panelLoading },
)

/* ------------------------------ Inline panel ---------------------------- */

export function InlinePanel({
  intent,
  settings,
  onSettingsChange,
  lessons,
  onLessonsChange,
  onClose,
}: {
  intent: ConsoleIntent
  settings: AiAssistSettings
  onSettingsChange: (s: AiAssistSettings) => void
  lessons: AiAssistLesson[]
  onLessonsChange: (l: AiAssistLesson[]) => void
  onClose: () => void
}) {
  const meta = INTENT_BY_ID[intent]
  const Icon = PANEL_ICON[intent]
  return (
    <Card className="ml-9 flex flex-col gap-3 border-primary/20 p-4 duration-300 animate-in fade-in slide-in-from-top-1">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 rounded-md bg-primary/10 p-1.5 text-primary">
            <Icon className="size-4" />
          </span>
          <div>
            <p className="text-sm font-medium">{meta?.label}</p>
            {meta ? (
              <p className="text-xs text-muted-foreground">{meta.description}</p>
            ) : null}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="shrink-0 gap-1.5"
        >
          <X className="size-4" />
          Закрыть
        </Button>
      </div>
      <PanelBody
        intent={intent}
        settings={settings}
        onSettingsChange={onSettingsChange}
        lessons={lessons}
        onLessonsChange={onLessonsChange}
      />
    </Card>
  )
}

/** Renders the concrete panel for an intent. */
function PanelBody({
  intent,
  settings,
  onSettingsChange,
  lessons,
  onLessonsChange,
}: {
  intent: ConsoleIntent
  settings: AiAssistSettings
  onSettingsChange: (s: AiAssistSettings) => void
  lessons: AiAssistLesson[]
  onLessonsChange: (l: AiAssistLesson[]) => void
}) {
  switch (intent) {
    case 'settings':
      return <SettingsTab settings={settings} onChange={onSettingsChange} />
    case 'aggressiveness':
      return (
        <SettingsTab
          settings={settings}
          onChange={onSettingsChange}
          focus="aggressiveness"
        />
      )
    case 'knowledge':
      return <KnowledgeBaseCard />
    case 'training':
      return <TrainingTab lessons={lessons} onLessonsChange={onLessonsChange} />
    case 'corrections':
      return <AiCorrectionsTab />
    case 'dialogs':
      return <AiEnrollmentTab />
    case 'logs':
      return <AiLogsTab />
    default:
      return null
  }
}

/* -------------------------- Pending confirmation ------------------------ */

/**
 * Confirm/Cancel card for a guarded high-impact action the assistant proposed
 * but won't run until approved (disable AI, max aggressiveness).
 */
export function PendingCard({
  detail,
  label,
  onConfirm,
  onDismiss,
}: {
  detail: string
  label: string
  onConfirm: () => void
  onDismiss: () => void
}) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="ml-9 flex flex-col gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3.5 duration-300 animate-in fade-in slide-in-from-top-1">
      <p className="flex items-start gap-2 text-sm text-pretty">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <span>{detail}</span>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => {
            setBusy(true)
            onConfirm()
          }}
          disabled={busy}
          className="gap-1.5"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Check className="size-4" />
          )}
          {label}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDismiss}
          disabled={busy}
          className="gap-1.5"
        >
          <X className="size-4" />
          Отмена
        </Button>
      </div>
    </div>
  )
}
