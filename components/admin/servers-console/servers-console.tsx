'use client'

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  ArrowUp,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  Mic,
  Plus,
  Rocket,
  Server,
  ServerCog,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  AssistantResult,
  AssistantTurn,
  CredentialRequest,
  ExecutedAction,
  LaunchedDeploy,
  OpenPanel,
} from '@/lib/servers-console/assistant'
import { INTENT_CATALOGUE } from '@/lib/servers-console/intents'
import {
  cancelAiDeployAction,
  refreshServersAction,
  saveRepoTokenAction,
  saveServerCredentialsAction,
  serversAssistantAction,
} from '@/app/actions/hosting-console'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import dynamic from 'next/dynamic'
import { DeploymentLogs } from '@/components/admin/hosting/deployment-logs'

// The full servers table (with its dialogs and forms) is only needed when the
// assistant opens an inline panel — keep it out of the console's initial chunk
// so the chat itself loads faster.
const ServersAdmin = dynamic(
  () =>
    import('@/components/admin/hosting/servers-admin').then(
      (m) => m.ServersAdmin,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    ),
  },
)
import { useSpeechInput } from '@/components/admin/ai-console/use-speech-input'
import type { HostingServer } from '@/lib/types'
import type { ChatMessage } from './chat-types'
import {
  ActionReceipts,
  Bar,
  EmptyHero,
  MessageBubble,
  StatusStrip,
  pluralServers,
} from './bubbles'
import { CredentialCard } from './credential-card'
import { DeployCard, InlinePanel } from './deploy-card'

/** Quick prompts shown as chips once a conversation is underway. */
const QUICK_PROMPTS = INTENT_CATALOGUE.map((m) => ({
  label: m.label,
  prompt: m.examples[0],
}))

let idSeq = 0
const nextId = () => `m${Date.now()}_${idSeq++}`

interface Props {
  initialServers: HostingServer[]
  configured: boolean
  workerOnline: boolean
}

export function ServersConsole({
  initialServers,
  configured,
  workerOnline,
}: Props) {
  const [servers, setServers] = useState(initialServers)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  const [voiceMode, setVoiceMode] = useState(false)
  const [ttsSupported, setTtsSupported] = useState(false)

  // The single inline panel currently expanded, tied to the message that opened it.
  const [activePanel, setActivePanel] = useState<OpenPanel | null>(null)
  const [activePanelMsgId, setActivePanelMsgId] = useState<string | null>(null)

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const reqRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const closePanel = useCallback(() => {
    setActivePanel(null)
    setActivePanelMsgId(null)
  }, [])

  const refreshServers = useCallback(async () => {
    try {
      const fresh = await refreshServersAction()
      setServers(fresh)
    } catch {
      /* non-fatal — panels still work with the last known state */
    }
  }, [])

  const speak = useCallback(
    (text: string) => {
      if (!voiceMode || typeof window === 'undefined') return
      const synth = window.speechSynthesis
      if (!synth) return
      synth.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'ru-RU'
      synth.speak(u)
    },
    [voiceMode],
  )

  useEffect(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTtsSupported(true)
    }
  }, [])

  const send = useCallback(
    (raw: string) => {
      const q = raw.trim()
      if (!q || loading) return

      stickRef.current = true

      const userMsg: ChatMessage = { id: nextId(), role: 'user', content: q }
      const withUser = [...messages, userMsg]
      setMessages(withUser)
      setInput('')
      setLoading(true)

      const historyTurns: AssistantTurn[] = withUser.map((m) => ({
        role: m.role,
        content: m.content,
      }))

      const token = ++reqRef.current
      const asstId = nextId()
      const controller = new AbortController()
      abortRef.current = controller

      setMessages((prev) => [
        ...prev,
        { id: asstId, role: 'assistant', content: '', streaming: true },
      ])

      const applyResult = async (res: AssistantResult) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === asstId
              ? {
                  ...m,
                  content: res.reply,
                  actions: res.actions,
                  openPanel: res.openPanel,
                  credentialRequest: res.credentialRequest,
                  launchedDeploy: res.launchedDeploy,
                  source: res.source,
                  streaming: false,
                }
              : m,
          ),
        )
        if (res.openPanel) {
          setActivePanel(res.openPanel)
          setActivePanelMsgId(asstId)
        }
        if (res.dataChanged) await refreshServers()
        speak(res.reply)
      }

      ;(async () => {
        try {
          const resp = await fetch('/api/admin/servers-console/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ history: historyTurns }),
            signal: controller.signal,
          })
          if (!resp.ok || !resp.body) throw new Error('stream failed')

          const reader = resp.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let streamed = ''
          let meta: Omit<AssistantResult, 'reply'> | null = null

          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            if (reqRef.current !== token) {
              await reader.cancel()
              return
            }
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed.startsWith('data:')) continue
              const payload = trimmed.slice(5).trim()
              if (!payload || payload === '[DONE]') continue
              try {
                const evt = JSON.parse(payload) as
                  | { t: 'delta'; v: string }
                  | { t: 'meta'; v: Omit<AssistantResult, 'reply'> }
                  | { t: 'error' }
                if (evt.t === 'delta') {
                  streamed += evt.v
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === asstId ? { ...m, content: streamed } : m,
                    ),
                  )
                } else if (evt.t === 'meta') {
                  meta = evt.v
                } else if (evt.t === 'error') {
                  throw new Error('generation error')
                }
              } catch {
                /* ignore malformed line */
              }
            }
          }

          if (reqRef.current !== token) return
          await applyResult({
            reply: streamed.trim() || 'Готово.',
            actions: meta?.actions ?? [],
            openPanel: meta?.openPanel ?? null,
            credentialRequest: meta?.credentialRequest ?? null,
            launchedDeploy: meta?.launchedDeploy ?? null,
            dataChanged: meta?.dataChanged ?? false,
            source: meta?.source ?? 'ai',
          })
        } catch (err) {
          if (
            reqRef.current !== token ||
            (err instanceof DOMException && err.name === 'AbortError')
          ) {
            return
          }
          // Streaming failed — fall back to the one-shot server action.
          try {
            const res = await serversAssistantAction(historyTurns)
            if (reqRef.current !== token) return
            await applyResult(res)
          } catch {
            if (reqRef.current !== token) return
            toast.error('Не удалось получить ответ. Попробуйте ещё раз.')
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstId
                  ? {
                      ...m,
                      content:
                        'Что-то пошло не так со связью. Попробуйте ещё раз.',
                      streaming: false,
                    }
                  : m,
              ),
            )
          }
        } finally {
          if (reqRef.current === token) {
            setLoading(false)
            abortRef.current = null
          }
        }
      })()
    },
    [messages, loading, refreshServers, speak],
  )

  const stop = useCallback(() => {
    reqRef.current++
    abortRef.current?.abort()
    abortRef.current = null
    setLoading(false)
    setMessages((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    )
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
  }, [])

  const newChat = useCallback(() => {
    reqRef.current++
    setMessages([])
    setInput('')
    setLoading(false)
    closePanel()
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
    inputRef.current?.focus()
  }, [closePanel])

  const voice = useSpeechInput({
    onInterim: (text) => setInput(text),
    onFinal: (text) => send(text),
    onError: (code) => {
      if (code === 'no-speech' || code === 'aborted') return
      const message =
        code === 'not-allowed'
          ? 'Нет доступа к микрофону. Разрешите его в настройках браузера.'
          : code === 'audio-capture'
            ? 'Микрофон не найден. Подключите его и попробуйте снова.'
            : code === 'network'
              ? 'Нет связи с сервисом распознавания речи.'
              : 'Не удалось запустить голосовой ввод.'
      toast.error(message)
    },
  })

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      e.keyCode !== 229
    ) {
      e.preventDefault()
      send(input)
    }
  }

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!activePanel) return
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel()
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [activePanel, closePanel])

  useEffect(() => {
    const onScroll = () => {
      const doc = document.documentElement
      const gapToBottom = doc.scrollHeight - window.innerHeight - window.scrollY
      stickRef.current = gapToBottom < 200
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (!stickRef.current) return
    const raf = requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
    })
    return () => cancelAnimationFrame(raf)
  }, [messages, activePanel])

  const hasChat = messages.length > 0
  const onlineCount = servers.filter((s) => s.status === 'online').length

  return (
    <div className="flex flex-col gap-4">
      {hasChat ? (
        <StatusStrip
          serverCount={servers.length}
          onlineCount={onlineCount}
          workerOnline={workerOnline}
          onNewChat={newChat}
        />
      ) : null}

      {!configured ? (
        <Card className="border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-700 dark:text-amber-400">
          Ключ AI Gateway не найден. Полноценный разговор и автономная установка
          заработают, когда будет задан{' '}
          <code className="font-mono">AI_GATEWAY_API_KEY</code>. Пока я буду
          открывать нужные разделы по вашему запросу.
        </Card>
      ) : null}

      {!workerOnline ? (
        <Card className="border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          Воркер не в сети — серверы можно добавлять, но проверка связи и
          автономная установка требуют запущенного воркера на VPS.
        </Card>
      ) : null}

      {hasChat ? (
        <div className="flex flex-col gap-4">
          <ChatThread
            messages={messages}
            servers={servers}
            activePanel={activePanel}
            activePanelMsgId={activePanelMsgId}
            onClosePanel={closePanel}
            onCredentialSaved={refreshServers}
          />
          <div ref={bottomRef} className="scroll-mb-40" />
        </div>
      ) : (
        <EmptyHero />
      )}

      <Card
        className={cn(
          'z-10 flex flex-col gap-3 p-3 shadow-lg',
          hasChat && 'sticky bottom-4',
        )}
      >
        {voice.listening ? (
          <div className="flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary duration-300 animate-in fade-in">
            <span className="flex gap-0.5" aria-hidden="true">
              <Bar delay="0ms" />
              <Bar delay="120ms" />
              <Bar delay="240ms" />
            </span>
            Слушаю… говорите
          </div>
        ) : null}
        <div className="relative">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            disabled={loading}
            placeholder="Напишите, что сделать: «добавь сервер», «разверни репозиторий»…"
            className="resize-none pr-32"
            aria-label="Сообщение ассистенту серверов"
          />
          <div className="absolute bottom-2 right-2 flex items-center gap-1.5">
            {ttsSupported ? (
              <Button
                type="button"
                size="icon"
                variant={voiceMode ? 'default' : 'ghost'}
                className="size-8"
                onClick={() => {
                  if (voiceMode && window.speechSynthesis) {
                    window.speechSynthesis.cancel()
                  }
                  setVoiceMode((v) => !v)
                }}
                aria-label={
                  voiceMode ? 'Отключить озвучку ответов' : 'Озвучи��ать ответы'
                }
                aria-pressed={voiceMode}
                title={voiceMode ? 'Озвучка включена' : 'Озвучивать ответы'}
              >
                {voiceMode ? (
                  <Volume2 className="size-4" />
                ) : (
                  <VolumeX className="size-4" />
                )}
              </Button>
            ) : null}
            {voice.supported ? (
              <Button
                type="button"
                size="icon"
                variant={voice.listening ? 'default' : 'ghost'}
                className={cn('size-8', voice.listening && 'animate-pulse')}
                onClick={voice.toggle}
                disabled={loading}
                aria-label={
                  voice.listening ? 'Остановить запись' : 'Голосовой ввод'
                }
                aria-pressed={voice.listening}
              >
                <Mic className="size-4" />
              </Button>
            ) : null}
            {loading ? (
              <Button
                size="icon"
                variant="secondary"
                className="size-8"
                onClick={stop}
                aria-label="Остановить генерацию"
              >
                <Square className="size-3.5" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="size-8"
                disabled={!input.trim()}
                onClick={() => send(input)}
                aria-label="Отправить"
              >
                <ArrowUp className="size-4" />
              </Button>
            )}
          </div>
        </div>

        {hasChat ? (
          <div className="flex flex-wrap gap-1.5">
            {QUICK_PROMPTS.map((q) => (
              <button
                key={q.label}
                type="button"
                onClick={() => send(q.prompt)}
                disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                {q.label}
              </button>
            ))}
          </div>
        ) : null}
      </Card>

      {!hasChat ? (
        <div className="flex flex-wrap justify-center gap-1.5">
          {QUICK_PROMPTS.map((q) => (
            <button
              key={q.label}
              type="button"
              onClick={() => send(q.prompt)}
              className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted/60 hover:text-foreground"
            >
              {q.prompt}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------ Chat thread ----------------------------- */

/**
 * The whole message feed, memoized as one unit. The console keeps the input
 * value in root state, so WITHOUT this every keystroke re-rendered every
 * bubble, the live deploy log stream and the embedded servers table — the
 * exact "laggy typing on mobile" symptom. All props here are referentially
 * stable while typing, so keystrokes now skip the feed entirely.
 */
const ChatThread = memo(function ChatThread({
  messages,
  servers,
  activePanel,
  activePanelMsgId,
  onClosePanel,
  onCredentialSaved,
}: {
  messages: ChatMessage[]
  servers: HostingServer[]
  activePanel: OpenPanel | null
  activePanelMsgId: string | null
  onClosePanel: () => void
  onCredentialSaved: () => void
}) {
  return (
    <>
      {messages.map((m) => (
        <div key={m.id} className="flex flex-col gap-3">
          <MessageBubble message={m} />
          {m.actions && m.actions.length > 0 ? (
            <ActionReceipts actions={m.actions} />
          ) : null}
          {m.credentialRequest ? (
            <CredentialCard
              request={m.credentialRequest}
              onSaved={onCredentialSaved}
            />
          ) : null}
          {m.launchedDeploy ? <DeployCard deploy={m.launchedDeploy} /> : null}
          {m.openPanel && activePanelMsgId === m.id && activePanel ? (
            <InlinePanel
              panel={activePanel}
              servers={servers}
              onClose={onClosePanel}
            />
          ) : null}
        </div>
      ))}
    </>
  )
})

