'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ServersAdmin } from '@/components/admin/hosting/servers-admin'
import { DeploymentLogs } from '@/components/admin/hosting/deployment-logs'
import { useSpeechInput } from '@/components/admin/ai-console/use-speech-input'
import type { HostingServer, ServerAuthType } from '@/lib/types'

/** One rendered turn in the conversation. */
interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  actions?: ExecutedAction[]
  openPanel?: OpenPanel | null
  credentialRequest?: CredentialRequest | null
  launchedDeploy?: LaunchedDeploy | null
  source?: AssistantResult['source']
  streaming?: boolean
}

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
          {messages.map((m) => (
            <div key={m.id} className="flex flex-col gap-3">
              <MessageBubble message={m} />
              {m.actions && m.actions.length > 0 ? (
                <ActionReceipts actions={m.actions} />
              ) : null}
              {m.credentialRequest ? (
                <CredentialCard
                  request={m.credentialRequest}
                  onSaved={() => {
                    void refreshServers()
                  }}
                />
              ) : null}
              {m.launchedDeploy ? (
                <DeployCard deploy={m.launchedDeploy} />
              ) : null}
              {m.openPanel && activePanelMsgId === m.id && activePanel ? (
                <InlinePanel
                  panel={activePanel}
                  servers={servers}
                  onClose={closePanel}
                />
              ) : null}
            </div>
          ))}
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
                  voiceMode ? 'Отключить озвучку ответов' : 'Озвучивать ответы'
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

/* ------------------------------ Status strip ---------------------------- */

function StatusStrip({
  serverCount,
  onlineCount,
  workerOnline,
  onNewChat,
}: {
  serverCount: number
  onlineCount: number
  workerOnline: boolean
  onNewChat: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusChip
        icon={Server}
        tone="neutral"
        label={`${serverCount} ${pluralServers(serverCount)}`}
      />
      <StatusChip
        icon={ServerCog}
        tone={onlineCount > 0 ? 'on' : 'off'}
        label={`${onlineCount} онлайн`}
      />
      <StatusChip
        icon={ServerCog}
        tone={workerOnline ? 'on' : 'off'}
        label={workerOnline ? 'Воркер в сети' : 'Воркер офлайн'}
      />
      <Button
        variant="ghost"
        size="sm"
        onClick={onNewChat}
        className="ml-auto gap-1.5 text-muted-foreground"
      >
        <Plus className="size-4" />
        Новый диалог
      </Button>
    </div>
  )
}

function StatusChip({
  icon: Icon,
  label,
  tone,
}: {
  icon: typeof Server
  label: string
  tone: 'on' | 'off' | 'neutral'
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        tone === 'on' &&
          'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        tone === 'off' && 'border-border bg-muted/50 text-muted-foreground',
        tone === 'neutral' && 'border-border bg-card text-foreground',
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </span>
  )
}

/* ------------------------------ Message bubbles -------------------------- */

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Не удалось скопировать.')
    }
  }

  return (
    <div
      className={cn(
        'group flex gap-2.5 duration-300 animate-in fade-in slide-in-from-bottom-2',
        isUser ? 'flex-row-reverse' : 'flex-row',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
          isUser ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary',
        )}
        aria-hidden="true"
      >
        {isUser ? (
          <span className="text-xs font-semibold">Вы</span>
        ) : (
          <ServerCog className="size-4" />
        )}
      </span>
      <div
        className={cn(
          'flex max-w-[85%] flex-col gap-1',
          isUser ? 'items-end' : 'items-start',
        )}
      >
        <div
          className={cn(
            'rounded-2xl px-3.5 py-2.5 text-sm',
            isUser
              ? 'rounded-tr-sm bg-primary text-primary-foreground'
              : 'rounded-tl-sm bg-muted text-foreground',
          )}
        >
          {message.role === 'assistant' && message.streaming ? (
            message.content ? (
              <p className="whitespace-pre-wrap text-pretty leading-relaxed">
                {message.content}
                <span className="ml-0.5 inline-block h-4 w-0.5 -translate-y-px animate-pulse bg-foreground/70 align-middle" />
              </p>
            ) : (
              <span className="flex gap-1" aria-label="Печатает">
                <Dot delay="0ms" />
                <Dot delay="150ms" />
                <Dot delay="300ms" />
              </span>
            )
          ) : (
            <p className="whitespace-pre-wrap text-pretty leading-relaxed">
              {message.content}
            </p>
          )}
        </div>
        {message.role === 'assistant' && message.content ? (
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-1 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
            aria-label="Скопировать ответ"
          >
            {copied ? (
              <>
                <Check className="size-3" />
                Скопировано
              </>
            ) : (
              <>
                <Copy className="size-3" />
                Копировать
              </>
            )}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
      style={{ animationDelay: delay }}
    />
  )
}

function Bar({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block w-0.5 animate-pulse rounded-full bg-primary"
      style={{ height: '0.75rem', animationDelay: delay }}
    />
  )
}

/** Receipts for the concrete actions performed during a turn. */
function ActionReceipts({ actions }: { actions: ExecutedAction[] }) {
  return (
    <div className="ml-9 flex flex-wrap gap-1.5 duration-300 animate-in fade-in">
      {actions.map((a, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary"
        >
          <Check className="size-3.5" />
          {a.label}
        </span>
      ))}
    </div>
  )
}

/* ------------------------- Secure credential card ----------------------- */

/**
 * The one place the admin enters a secret (SSH key/password or GitHub token).
 * It submits straight to a server action — the value NEVER passes through the
 * LLM or the chat transcript.
 */
function CredentialCard({
  request,
  onSaved,
}: {
  request: CredentialRequest
  onSaved: () => void
}) {
  const [done, setDone] = useState(false)
  if (request.kind === 'repo_token') {
    return (
      <RepoTokenForm request={request} done={done} setDone={setDone} onSaved={onSaved} />
    )
  }
  return (
    <ServerCredentialForm
      request={request}
      done={done}
      setDone={setDone}
      onSaved={onSaved}
    />
  )
}

function ServerCredentialForm({
  request,
  done,
  setDone,
  onSaved,
}: {
  request: CredentialRequest
  done: boolean
  setDone: (v: boolean) => void
  onSaved: () => void
}) {
  const [authType, setAuthType] = useState<ServerAuthType>(
    request.authType ?? 'ssh_key',
  )
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setBusy(true)
    try {
      const fd = new FormData(e.currentTarget)
      fd.set('authType', authType)
      const res = await saveServerCredentialsAction(fd)
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      setDone(true)
      onSaved()
    } catch {
      toast.error('Не удалось сохранить сервер.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <SavedNote text="Сервер подключён. Теперь можно сказать: «разверни репозиторий …»." />
    )
  }

  return (
    <Card className="ml-9 flex flex-col gap-3 border-primary/20 p-4 duration-300 animate-in fade-in slide-in-from-top-1">
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-primary/10 p-1.5 text-primary">
          <KeyRound className="size-4" />
        </span>
        <div>
          <p className="text-sm font-medium">Подключение сервера</p>
          <p className="text-xs text-muted-foreground">
            {request.note ?? 'Секрет вводится напрямую и не проходит через ИИ.'}
          </p>
        </div>
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Название">
            <Input name="name" defaultValue={request.name ?? ''} required placeholder="Прод-сервер" />
          </Field>
          <Field label="IP-адрес или хост">
            <Input
              name="ipAddress"
              defaultValue={request.ipAddress ?? ''}
              required
              placeholder="203.0.113.10"
            />
          </Field>
          <Field label="SSH-порт">
            <Input
              name="sshPort"
              type="number"
              defaultValue={String(request.sshPort ?? 22)}
              min={1}
              max={65535}
            />
          </Field>
          <Field label="Пользователь">
            <Input
              name="sshUsername"
              defaultValue={request.sshUsername ?? 'root'}
              placeholder="root"
            />
          </Field>
          <Field label="Способ входа">
            <Select
              value={authType}
              onValueChange={(v) => setAuthType(v as ServerAuthType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ssh_key">SSH-ключ</SelectItem>
                <SelectItem value="password">Пароль</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field
          label={authType === 'ssh_key' ? 'Приватный SSH-ключ' : 'Пароль SSH'}
        >
          {authType === 'ssh_key' ? (
            <Textarea
              name="secret"
              required
              rows={4}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              className="resize-none font-mono text-xs"
              autoComplete="off"
            />
          ) : (
            <Input
              name="secret"
              type="password"
              required
              placeholder="••••••••"
              autoComplete="off"
            />
          )}
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={busy} className="gap-1.5">
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ServerCog className="size-4" />
            )}
            Подключить сервер
          </Button>
        </div>
      </form>
    </Card>
  )
}

function RepoTokenForm({
  request,
  done,
  setDone,
  onSaved,
}: {
  request: CredentialRequest
  done: boolean
  setDone: (v: boolean) => void
  onSaved: () => void
}) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!request.appId) {
      toast.error('Не указано приложение для токена.')
      return
    }
    setBusy(true)
    try {
      const res = await saveRepoTokenAction(request.appId, token)
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      setDone(true)
      onSaved()
    } catch {
      toast.error('Не удалось сохранить токен.')
    } finally {
      setBusy(false)
    }
  }

  if (done) return <SavedNote text="Токен сохранён. Можно запускать установку." />

  return (
    <Card className="ml-9 flex flex-col gap-3 border-primary/20 p-4 duration-300 animate-in fade-in slide-in-from-top-1">
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-primary/10 p-1.5 text-primary">
          <KeyRound className="size-4" />
        </span>
        <div>
          <p className="text-sm font-medium">Токен приватного репозитория</p>
          <p className="text-xs text-muted-foreground">
            {request.note ?? 'Токен вводится напрямую и не проходит через ИИ.'}
          </p>
        </div>
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field label="GitHub-токен">
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            placeholder="ghp_…"
            autoComplete="off"
          />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={busy || !token.trim()} className="gap-1.5">
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <KeyRound className="size-4" />
            )}
            Сохранить токен
          </Button>
        </div>
      </form>
    </Card>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

function SavedNote({ text }: { text: string }) {
  return (
    <div className="ml-9 flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/5 px-3.5 py-2.5 text-sm text-emerald-600 duration-300 animate-in fade-in dark:text-emerald-400">
      <Check className="size-4 shrink-0" />
      {text}
    </div>
  )
}

/* --------------------------- Live deploy card --------------------------- */

/**
 * The autonomous deploy launcher: shows what the agent is installing and embeds
 * the live log stream so the admin watches every step in real time, with a Stop
 * button to cancel mid-flight.
 */
function DeployCard({ deploy }: { deploy: LaunchedDeploy }) {
  const [canceled, setCanceled] = useState(false)
  const [busy, setBusy] = useState(false)

  const cancel = async () => {
    setBusy(true)
    try {
      const res = await cancelAiDeployAction(deploy.deploymentId)
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      setCanceled(true)
    } catch {
      toast.error('Не удалось отменить установку.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="ml-9 flex flex-col gap-3 border-primary/20 p-4 duration-300 animate-in fade-in slide-in-from-top-1">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 rounded-md bg-primary/10 p-1.5 text-primary">
            <Rocket className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium">
              ИИ разворачивает «{deploy.appName}» на {deploy.serverName}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {deploy.repoUrl}
              {deploy.domain ? ` → ${deploy.domain}` : ''}
            </p>
          </div>
        </div>
        {!canceled ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={cancel}
            disabled={busy}
            className="shrink-0 gap-1.5 text-muted-foreground"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Square className="size-3.5" />
            )}
            Остановить
          </Button>
        ) : null}
      </div>
      {deploy.domain ? (
        <a
          href={`https://${deploy.domain}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1.5 text-xs text-primary hover:underline"
        >
          <ExternalLink className="size-3.5" />
          {`https://${deploy.domain}`}
        </a>
      ) : null}
      <DeploymentLogs
        deploymentId={deploy.deploymentId}
        initialStatus="queued"
      />
    </Card>
  )
}

/* ------------------------------ Inline panel ---------------------------- */

function InlinePanel({
  panel,
  servers,
  onClose,
}: {
  panel: OpenPanel
  servers: HostingServer[]
  onClose: () => void
}) {
  return (
    <Card className="ml-9 flex flex-col gap-3 border-primary/20 p-4 duration-300 animate-in fade-in slide-in-from-top-1">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-primary/10 p-1.5 text-primary">
            <Server className="size-4" />
          </span>
          <p className="text-sm font-medium">
            {panel.kind === 'servers'
              ? 'Серверы'
              : panel.kind === 'server'
                ? 'Сервер'
                : 'Приложение'}
          </p>
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
      {panel.kind === 'servers' ? (
        <ServersAdmin servers={servers} />
      ) : panel.kind === 'server' ? (
        <PanelLink href={`/admin/servers/${panel.id}`} label="Открыть сервер" />
      ) : (
        <PanelLink
          href={`/admin/servers/${panel.serverId}/apps/${panel.id}`}
          label="Открыть приложение"
        />
      )}
    </Card>
  )
}

function PanelLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted/60"
    >
      <ExternalLink className="size-4" />
      {label}
    </Link>
  )
}

/* ------------------------------- Empty hero ----------------------------- */

function EmptyHero() {
  return (
    <div className="flex min-h-[42vh] flex-col items-center justify-center gap-6 py-8 text-center duration-500 animate-in fade-in">
      <span className="flex size-16 items-center justify-center rounded-3xl bg-primary/10 text-primary">
        <ServerCog className="size-8" />
      </span>
      <h2 className="max-w-xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        Что развернём сегодня?
      </h2>
      <p className="max-w-md text-pretty text-sm text-muted-foreground">
        Подключите сервер и дайте ссылку на репозиторий — ИИ сам зайдёт, всё
        установит и поднимет проект, показывая каждый шаг в живом логе.
      </p>
    </div>
  )
}

/* -------------------------------- Plurals ------------------------------- */

function pluralServers(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'сервер'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'сервера'
  return 'серверов'
}
