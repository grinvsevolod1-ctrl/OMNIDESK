'use client'

import { BrainCircuit } from 'lucide-react'

/**
 * The "AI leads this thread" banner shown at the top of the composer while the
 * manager is locked out of replying. Tapping it toggles the AI off so the
 * manager can take over. Extracted verbatim from message-composer.tsx — it is
 * purely presentational and shares none of the composer's hot-path refs, so it
 * lives on its own to keep the composer's coupled send-core smaller.
 */
export function AiLedBanner({
  onToggleAi,
  statusPending,
}: {
  onToggleAi: () => void
  statusPending: boolean
}) {
  return (
    <button
      type="button"
      onClick={onToggleAi}
      disabled={statusPending}
      className="flex w-full items-center gap-2 border-b border-primary/20 bg-primary/10 px-4 py-2 text-left text-xs font-medium text-primary transition-colors hover:bg-primary/15"
    >
      <BrainCircuit className="size-3.5 shrink-0" />
      <span className="flex-1">
        ИИ ведёт этот диалог. Отключите ИИ, чтобы ответить самому.
      </span>
      <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[10px] text-primary-foreground">
        Отключить ИИ
      </span>
    </button>
  )
}
