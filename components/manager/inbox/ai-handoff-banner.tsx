'use client'

import { BrainCircuit } from 'lucide-react'
import type { Conversation } from '@/lib/types'

/**
 * AI hand-off banner — leads the AI promoted to «Ликвид» and handed to a
 * human. Click to jump to the newest; opening a thread clears it.
 */
export function AiHandoffBanner({
  pendingHandoffs,
  onOpen,
}: {
  pendingHandoffs: Conversation[]
  onOpen: (conversationId: string) => void
}) {
  if (pendingHandoffs.length === 0) return null
  return (
    <button
      type="button"
      onClick={() => onOpen(pendingHandoffs[0].id)}
      className="flex shrink-0 items-center gap-2.5 border-b border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-left text-sm text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-300"
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-emerald-50">
        <BrainCircuit className="size-3.5" />
      </span>
      <span className="flex-1 font-medium">
        {pendingHandoffs.length === 1
          ? `ИИ передал лид «${pendingHandoffs[0].contactName}» — готов к работе (Ликвид).`
          : `ИИ передал ${pendingHandoffs.length} лид(ов) — готовы к работе (Ликвид).`}
      </span>
      <span className="shrink-0 rounded-full bg-emerald-500 px-2.5 py-0.5 text-xs font-semibold text-emerald-50">
        Открыть
      </span>
    </button>
  )
}
