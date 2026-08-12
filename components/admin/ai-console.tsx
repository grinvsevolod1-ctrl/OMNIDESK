'use client'

/**
 * Чат Admin AI (копилот админки) — презентационный контейнер. Вся логика
 * (стриминг, подтверждения, пресеты, undo, голос, скролл) — в
 * ai-console/use-ai-console.ts; подкомпоненты — в ai-console/.
 */

import type { AiAssistLesson, AiAssistSettings } from '@/lib/data/ai-assist'
import type { ConsoleIntent } from '@/lib/ai-console/intents'
import { presetSummary } from '@/lib/ai-console/presets'
import { Card } from '@/components/ui/card'

import { useAiConsole } from '@/components/admin/ai-console/use-ai-console'
import {
  ActionReceipts,
  EmptyHero,
  MessageBubble,
  ReportDownload,
  StatusStrip,
  Suggestions,
} from '@/components/admin/ai-console/bubbles'
import {
  InlinePanel,
  PendingCard,
} from '@/components/admin/ai-console/inline-panel'
import { ConsoleComposer } from '@/components/admin/ai-console/console-composer'

/** Quick-access panels shown as a compact row (instant open, no model call). */
const QUICK_PANELS: ConsoleIntent[] = [
  'settings',
  'aggressiveness',
  'knowledge',
  'training',
  'corrections',
  'dialogs',
  'logs',
]

interface Props {
  initialSettings: AiAssistSettings
  initialLessons: AiAssistLesson[]
  initialLessonCount: number
  configured: boolean
}

export function AiConsole({
  initialSettings,
  initialLessons,
  initialLessonCount,
  configured,
}: Props) {
  const c = useAiConsole(initialSettings, initialLessons, initialLessonCount)

  return (
    <div className="flex flex-col gap-4">
      {/* Status is context, not a landing-screen summary: only show it once a
          conversation is underway. The empty screen stays a single question. */}
      {c.hasChat ? (
        <StatusStrip
          settings={c.settings}
          lessonCount={c.lessonCount}
          hasChat={c.hasChat}
          onNewChat={c.newChat}
        />
      ) : null}

      {!configured ? (
        <Card className="border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-700 dark:text-amber-400">
          Ключ AI Gateway не найден. Полноценный разговор с ассистентом заработает,
          когда будет задан <code className="font-mono">AI_GATEWAY_API_KEY</code>.
          Пока я буду просто открывать нужные разделы по вашему запросу — все
          настройки и обучение доступны.
        </Card>
      ) : null}

      {/* Conversation thread (or the empty-state hero). */}
      {c.hasChat ? (
        <div className="flex flex-col gap-4">
          {c.messages.map((m) => (
            <div key={m.id} className="flex flex-col gap-3">
              <MessageBubble message={m} />
              {m.pending ? (
                <PendingCard
                  detail={m.pending.detail}
                  label={m.pending.label}
                  onConfirm={() => c.confirmPending(m.id, m.pending!)}
                  onDismiss={() => c.dismissPending(m.id)}
                />
              ) : null}
              {m.presetConfirm ? (
                <PendingCard
                  detail={presetSummary(m.presetConfirm)}
                  label={`Включить «${m.presetConfirm.name}»`}
                  onConfirm={() => {
                    const preset = m.presetConfirm!
                    c.dismissPresetConfirm(m.id)
                    void c.applyPreset(preset, true)
                  }}
                  onDismiss={() => c.dismissPresetConfirm(m.id)}
                />
              ) : null}
              {m.actions && m.actions.length > 0 ? (
                <ActionReceipts
                  actions={m.actions}
                  messageId={m.id}
                  undone={c.undone}
                  onUndo={c.undo}
                />
              ) : null}
              {m.report ? <ReportDownload report={m.report} /> : null}
              {m.openPanel && c.activePanelMsgId === m.id && c.activePanel ? (
                <InlinePanel
                  intent={c.activePanel}
                  settings={c.settings}
                  onSettingsChange={c.setSettings}
                  lessons={c.lessons}
                  onLessonsChange={(next) => {
                    c.setLessons(next)
                    c.setLessonCount(next.length)
                  }}
                  onClose={c.closePanel}
                />
              ) : null}
            </div>
          ))}
          {c.suggestions.length > 0 ? (
            <Suggestions items={c.suggestions} onPick={c.send} />
          ) : null}
          {/* scroll-mb clears the sticky composer: aligning this anchor to the
              viewport bottom would otherwise park the newest lines behind it. */}
          <div ref={c.bottomRef} className="scroll-mb-40" />
        </div>
      ) : (
        <EmptyHero />
      )}

      {/* Composer — the one place you talk to the assistant. It only pins to the
          bottom once a conversation is going; on the empty screen it sits right
          under the question as the single focal element. */}
      <ConsoleComposer
        inputRef={c.inputRef}
        input={c.input}
        onInputChange={c.setInput}
        onKeyDown={c.onKeyDown}
        loading={c.loading}
        hasChat={c.hasChat}
        voice={c.voice}
        voiceMode={c.voiceMode}
        ttsSupported={c.ttsSupported}
        onToggleVoiceMode={c.toggleVoiceMode}
        onStop={c.stop}
        onSend={c.send}
        quickPanels={QUICK_PANELS}
        activePanel={c.activePanel}
        onOpenPanel={c.openPanelDirect}
      />
    </div>
  )
}
