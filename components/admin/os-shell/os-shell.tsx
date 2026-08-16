'use client'

/**
 * OMNIDESK OS — the command shell that IS the admin panel. One Raycast-style
 * command field + a copilot with full admin powers replaces the classic tabs.
 * Dark glass theme is scoped via the `.od-os` class (globals.css), so the rest
 * of the app keeps its own theme.
 *
 * Презентационный контейнер: вся логика (SSE-пайплайн, подтверждения, история,
 * голос, инсайты) — в use-os-ts; командная капсула — command-bar.tsx;
 * история — history-dialog.tsx.
 */

import {
  History,
  LayoutPanelLeft,
  LogOut,
  MessageSquarePlus,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Dictionaries } from '@/lib/dictionaries'
import type { AssistantTurn } from '@/lib/admin-console/assistant'
import { SHELL_SECTIONS } from '@/lib/admin-console/intents'
import type { ShellInsight } from '@/lib/admin-console/insights'
import { logoutAction } from '@/app/actions/auth'
import { ShellHero, ShellMessageRow } from './feed'
import { sectionPrompt } from './shell-helpers'
import { useOsShell } from './use-os-shell'
import { ShellCommandBar } from './command-bar'
import { ShellHistoryDialog } from './history-dialog'

export function OsShell({
  dictionaries,
  insights = [],
  savedSession = null,
}: {
  dictionaries: Dictionaries
  insights?: ShellInsight[]
  savedSession?: AssistantTurn[] | null
}) {
  const {
    messages,
    busy,
    confirmBusy,
    input,
    setInput,
    inputRef,
    scrollRef,
    send,
    sendCommand,
    confirm,
    cancelPending,
    toClassic,
    newDialog,
    historyOpen,
    setHistoryOpen,
    historyItems,
    openHistory,
    restoreDialog,
    listening,
    voiceSupported,
    toggleVoice,
    insightsVisible,
    dismissInsights,
  } = useOsShell(savedSession, insights.length)
  const hasChat = messages.length > 0

  return (
    <div className="od-os flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      {/* Ambient light — a soft breathing top glow, like the desktop wallpaper
          bleeding through macOS glass. Pure CSS, zero JS cost. */}
      <div
        aria-hidden="true"
        className="od-ambient pointer-events-none fixed inset-x-0 top-0 h-72 bg-gradient-to-b from-primary/10 to-transparent"
      />

      {/* Titlebar */}
      <header className="z-20 shrink-0 border-b border-border bg-background/70 backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto flex h-12 w-full max-w-4xl items-center gap-3 px-4">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
            Omnidesk OS
          </span>
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:inline">
            Копилот-админка
          </span>
          <div className="ml-auto flex items-center gap-1">
            {hasChat ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={newDialog}
                aria-label="Новый диалог"
                className="gap-1.5 text-muted-foreground"
              >
                <MessageSquarePlus className="size-4" />
                <span className="hidden sm:inline">Новый диалог</span>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void openHistory()}
              aria-label="История диалогов"
              className="gap-1.5 text-muted-foreground"
            >
              <History className="size-4" />
              <span className="hidden sm:inline">История</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={toClassic}
              aria-label="Классический режим"
              className="gap-1.5 text-muted-foreground"
            >
              <LayoutPanelLeft className="size-4" />
              <span className="hidden sm:inline">Классический режим</span>
            </Button>
            <form action={logoutAction}>
              <Button
                variant="ghost"
                size="icon"
                type="submit"
                aria-label="Выйти"
                className="text-muted-foreground"
              >
                <LogOut className="size-4" />
              </Button>
            </form>
          </div>
        </div>
      </header>

      {/* Scrollable feed area: the ONLY scroll container on the page. Header
          and command bar live outside it, so nothing ever slides under them
          and scrollTop-based autoscroll is exact. */}
      <div
        ref={scrollRef}
        className="scrollbar-thin flex flex-1 flex-col overflow-y-auto overscroll-contain"
      >
        {/* Section dock — pills wrap onto extra rows instead of clipping into a
            horizontal scroller (no scrollbar, always tidy). */}
        <nav
          aria-label="Разделы"
          className="mx-auto w-full max-w-4xl shrink-0 px-4 pt-4"
        >
          <ul className="flex flex-wrap justify-center gap-2">
            {SHELL_SECTIONS.filter((s) => s.id !== 'help').map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => sendCommand(sectionPrompt(s.id, s.title))}
                  className="press-scale whitespace-nowrap rounded-full border border-border bg-card/50 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-card hover:text-foreground"
                >
                  {s.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* Feed */}
        <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-6">
          {!hasChat ? (
            <>
              <ShellHero
                greeting={dictionaries.shellGreeting}
                insights={insightsVisible ? insights : []}
                onInsight={sendCommand}
                onDismissInsights={dismissInsights}
              />
              <div className="od-rise od-rise-4 flex flex-wrap justify-center gap-2">
                {dictionaries.shellQuickCommands.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    onClick={() => sendCommand(c.prompt)}
                    className="press-scale od-glass rounded-full px-4 py-2 text-sm text-muted-foreground transition-[color,translate,box-shadow] duration-200 hover:-translate-y-0.5 hover:text-foreground hover:shadow-[0_10px_28px_rgb(0_0_0/0.45)]"
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            messages.map((m) => (
              <ShellMessageRow
                key={m.id}
                message={m}
                onConfirm={confirm}
                onCancelPending={cancelPending}
                confirmBusy={confirmBusy}
                onCommand={sendCommand}
              />
            ))
          )}
        </main>
      </div>

      <ShellCommandBar
        input={input}
        setInput={setInput}
        inputRef={inputRef}
        busy={busy}
        listening={listening}
        voiceSupported={voiceSupported}
        onSend={(text) => void send(text)}
        onToggleVoice={toggleVoice}
      />

      <ShellHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        items={historyItems}
        onRestore={(id) => void restoreDialog(id)}
      />
    </div>
  )
}
