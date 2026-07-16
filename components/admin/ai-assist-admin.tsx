'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import {
  Bot,
  BrainCircuit,
  GraduationCap,
  Highlighter,
  Loader2,
  MessagesSquare,
  RefreshCw,
  ScrollText,
  Send,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  aiDeleteLessonAction,
  aiSampleConversationsAction,
  aiSaveLessonAction,
  aiSuggestReplyAction,
  aiTrainableAccountsAction,
  aiTrainOnAccountAction,
  aiUpdateSettingsAction,
} from '@/app/actions/ai-assist'
import type {
  AiAssistLesson,
  AiAssistSettings,
  TrainableAccount,
  TrainingSample,
} from '@/lib/data/ai-assist'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { AiLogsTab } from '@/components/admin/ai-logs-tab'
import { AiCorrectionsTab } from '@/components/admin/ai-corrections-tab'
import { AiEnrollmentTab } from '@/components/admin/ai-enrollment-tab'

const TONE_OPTIONS = [
  { value: 'professional', label: 'Деловой' },
  { value: 'friendly', label: 'Дружелюбный' },
  { value: 'concise', label: 'Краткий' },
  { value: 'persuasive', label: 'Убедительный' },
]

interface Props {
  initialSettings: AiAssistSettings
  initialLessons: AiAssistLesson[]
  initialLessonCount: number
  configured: boolean
}

export function AiAssistAdmin({
  initialSettings,
  initialLessons,
  initialLessonCount,
  configured,
}: Props) {
  const [settings, setSettings] = useState(initialSettings)
  const [lessons, setLessons] = useState(initialLessons)
  const [lessonCount, setLessonCount] = useState(initialLessonCount)

  const patchSettings = useCallback((next: AiAssistSettings) => {
    setSettings(next)
  }, [])

  return (
    <div className="flex flex-col gap-4">
      {!configured ? (
        <Card className="border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-700 dark:text-amber-400">
          Ключ AI Gateway не найден в переменных окружения. ИИ-ответы работать не
          будут, пока не задан <code className="font-mono">AI_GATEWAY_API_KEY</code>.
          Настройки и обучение доступны и сохранятся заранее.
        </Card>
      ) : null}

      <Tabs defaultValue="settings" className="w-full">
        <TabsList>
          <TabsTrigger value="settings">
            <Settings2 className="size-4" />
            Настройки
          </TabsTrigger>
          <TabsTrigger value="dialogs">
            <MessagesSquare className="size-4" />
            Диалоги
          </TabsTrigger>
          <TabsTrigger value="trainer">
            <GraduationCap className="size-4" />
            Тренажёр
            {lessonCount > 0 ? (
              <Badge variant="secondary" className="ml-1.5">
                {lessonCount}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="corrections">
            <Highlighter className="size-4" />
            Правки
          </TabsTrigger>
          <TabsTrigger value="logs">
            <ScrollText className="size-4" />
            Логи
          </TabsTrigger>
        </TabsList>

        <TabsContent value="settings" className="mt-4">
          <SettingsTab settings={settings} onChange={patchSettings} />
        </TabsContent>

        <TabsContent value="dialogs" className="mt-4">
          <AiEnrollmentTab />
        </TabsContent>

        <TabsContent value="trainer" className="mt-4">
          <TrainerTab
            lessons={lessons}
            onLessonsChange={(next) => {
              setLessons(next)
              setLessonCount(next.length)
            }}
          />
        </TabsContent>

        <TabsContent value="corrections" className="mt-4">
          <AiCorrectionsTab />
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <AiLogsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/* ------------------------------- Settings ------------------------------- */

function SettingsTab({
  settings,
  onChange,
}: {
  settings: AiAssistSettings
  onChange: (s: AiAssistSettings) => void
}) {
  const [persona, setPersona] = useState(settings.persona)
  const [tone, setTone] = useState(settings.tone)
  const [pending, startTransition] = useTransition()

  const save = (patch: {
    enabled?: boolean
    tone?: string
    persona?: string
  }) => {
    startTransition(async () => {
      try {
        const next = await aiUpdateSettingsAction(patch)
        onChange(next)
        setPersona(next.persona)
        setTone(next.tone)
        toast.success('Сохранено')
      } catch {
        toast.error('Не удалось сохранить')
      }
    })
  }

  const dirty = persona !== settings.persona || tone !== settings.tone

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary">
              <Bot className="size-5" />
            </div>
            <div>
              <p className="font-medium">Главный выключатель</p>
              <p className="text-sm text-muted-foreground">
                Когда выключено, менеджеры не могут включить ИИ в диалогах и
                авто-ответы не отправляются.
              </p>
            </div>
          </div>
          <Switch
            checked={settings.enabled}
            disabled={pending}
            onCheckedChange={(v) => save({ enabled: Boolean(v) })}
          />
        </div>
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="ai-tone">Тон общения</Label>
          <Select value={tone} onValueChange={(v) => setTone(v ?? 'professional')}>
            <SelectTrigger id="ai-tone" className="w-full sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TONE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="ai-persona">Контекст компании и правила общения</Label>
          <Textarea
            id="ai-persona"
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            rows={8}
            placeholder="Опишите, чем занимается компания, что предлагать клиентам, как общаться, какие правила соблюдать. Этот текст всегда учитывается при генерации ответа."
          />
          <p className="text-xs text-muted-foreground">
            Например: «Мы помогаем с трудоустройством. Всегда уточняем город и
            желаемый график, предлагаем оформить заявку. Не обещаем конкретную
            зарплату до собеседования.»
          </p>
        </div>

        <div className="flex justify-end">
          <Button
            disabled={!dirty || pending}
            onClick={() => save({ tone, persona })}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Сохранить
          </Button>
        </div>
      </Card>

      {settings.playbook.length > 0 ? (
        <Card className="flex flex-col gap-2 p-4">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            <p className="font-medium">Плейбук (выведен из обучения)</p>
          </div>
          <ul className="ml-1 flex list-inside list-disc flex-col gap-1 text-sm text-muted-foreground">
            {settings.playbook.map((rule, i) => (
              <li key={i}>{rule}</li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}

/* ------------------------------- Trainer -------------------------------- */

type ChatTurn = { role: 'client' | 'manager'; body: string }

function TrainerTab({
  lessons,
  onLessonsChange,
}: {
  lessons: AiAssistLesson[]
  onLessonsChange: (next: AiAssistLesson[]) => void
}) {
  const [samples, setSamples] = useState<TrainingSample[]>([])
  const [active, setActive] = useState<TrainingSample | null>(null)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const [loadingSamples, startLoadSamples] = useTransition()
  const [suggesting, startSuggest] = useTransition()
  const [saving, startSave] = useTransition()

  const loadSamples = () => {
    startLoadSamples(async () => {
      try {
        const s = await aiSampleConversationsAction()
        setSamples(s)
        if (s.length === 0) toast.info('Нет свежих диалогов для тренировки')
      } catch {
        toast.error('Не удалось загрузить диалоги')
      }
    })
  }

  const pickSample = (s: TrainingSample) => {
    setActive(s)
    setDraft('')
    setNote('')
  }

  const suggest = () => {
    if (!active) return
    startSuggest(async () => {
      try {
        const reply = await aiSuggestReplyAction({ history: active.history })
        if (reply) setDraft(reply)
        else toast.error('ИИ не смог предложить ответ (проверьте ключ и настройки)')
      } catch {
        toast.error('Ошибка генерации')
      }
    })
  }

  const saveLesson = () => {
    if (!active || !draft.trim()) return
    startSave(async () => {
      try {
        const { lessons: next } = await aiSaveLessonAction({
          situation: active.lastClientMessage,
          draft: '',
          corrected: draft.trim(),
          note,
        })
        onLessonsChange(next)
        toast.success('Урок сохранён, плейбук обновлён')
        setActive(null)
        setDraft('')
        setNote('')
      } catch {
        toast.error('Не удалось сохранить урок')
      }
    })
  }

  const removeLesson = (id: string) => {
    startSave(async () => {
      try {
        await aiDeleteLessonAction(id)
        onLessonsChange(lessons.filter((l) => l.id !== id))
        toast.success('Урок удалён')
      } catch {
        toast.error('Не удалось удалить')
      }
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <TrainOnAccountCard onLessonsChange={onLessonsChange} />

      <div className="grid gap-4 lg:grid-cols-2">
      {/* Left: pick a conversation and train */}
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-center justify-between">
          <p className="font-medium">Тренировка на диалогах</p>
          <Button
            variant="outline"
            size="sm"
            onClick={loadSamples}
            disabled={loadingSamples}
          >
            {loadingSamples ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Загрузить диалоги
          </Button>
        </div>

        {samples.length > 0 && !active ? (
          <div className="flex flex-col gap-2">
            {samples.map((s) => (
              <button
                key={s.conversationId}
                onClick={() => pickSample(s)}
                className="rounded-md border border-border p-3 text-left text-sm transition-colors hover:bg-muted"
              >
                <span className="line-clamp-2 text-foreground">
                  {s.lastClientMessage}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {!active && samples.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Нажмите «Загрузить диалоги», чтобы выбрать реальную переписку и
            обучить ИИ на правильных ответах.
          </p>
        ) : null}

        {active ? (
          <div className="flex flex-col gap-3">
            <div className="flex max-h-64 flex-col gap-2 overflow-y-auto rounded-md border border-border p-3">
              {active.history.map((m, i) => (
                <ChatBubble key={i} turn={m} />
              ))}
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="ai-draft">Ответ менеджера</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={suggest}
                  disabled={suggesting}
                >
                  {suggesting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                  Предложить
                </Button>
              </div>
              <Textarea
                id="ai-draft"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={4}
                placeholder="Напишите или отредактируйте образцовый ответ. Именно он сохранится как урок."
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="ai-note">Заметка (необязательно)</Label>
              <Textarea
                id="ai-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Почему так лучше отвечать — короткое пояснение для ИИ."
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setActive(null)
                  setDraft('')
                  setNote('')
                }}
              >
                Отмена
              </Button>
              <Button onClick={saveLesson} disabled={!draft.trim() || saving}>
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
                Сохранить урок
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      {/* Right: existing lessons */}
      <Card className="flex flex-col gap-3 p-4">
        <p className="font-medium">
          Уроки{' '}
          <span className="text-sm font-normal text-muted-foreground">
            ({lessons.length})
          </span>
        </p>
        <Separator />
        {lessons.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Пока нет уроков. Обучите ИИ на диалогах — каждый сохранённый ответ
            делает его умнее.
          </p>
        ) : (
          <div className="flex max-h-[32rem] flex-col gap-3 overflow-y-auto">
            {lessons.map((l) => (
              <div
                key={l.id}
                className="flex flex-col gap-1.5 rounded-md border border-border p-3 text-sm"
              >
                {l.situation ? (
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">Клиент:</span>{' '}
                    {l.situation}
                  </p>
                ) : null}
                <p>
                  <span className="font-medium text-primary">Ответ:</span>{' '}
                  {l.corrected}
                </p>
                {l.note ? (
                  <p className="text-xs text-muted-foreground">💡 {l.note}</p>
                ) : null}
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeLesson(l.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      </div>
    </div>
  )
}

/* -------------------------- Train on an account ------------------------- */

/**
 * Point the trainer at a real messaging account: the AI reads that account's
 * manager↔client dialogs, learns its selling style, stores the strongest
 * exchanges as lessons, and re-distills the playbook. This is how the operator
 * bootstraps the AI to "talk like this account does" and push leads the same
 * way its human managers do.
 */
function TrainOnAccountCard({
  onLessonsChange,
}: {
  onLessonsChange: (next: AiAssistLesson[]) => void
}) {
  const [accounts, setAccounts] = useState<TrainableAccount[]>([])
  const [selected, setSelected] = useState<string>('')
  const [loading, startLoad] = useTransition()
  const [training, startTrain] = useTransition()

  useEffect(() => {
    startLoad(async () => {
      try {
        const list = await aiTrainableAccountsAction()
        setAccounts(list)
        if (list.length > 0) setSelected(list[0].channelId)
      } catch {
        // silent — the card just shows an empty state
      }
    })
  }, [])

  const train = () => {
    if (!selected) return
    startTrain(async () => {
      try {
        const res = await aiTrainOnAccountAction({ channelId: selected })
        onLessonsChange(res.lessons)
        toast.success(
          `Обучение завершено: проанализировано диалогов — ${res.dialogsAnalysed}, добавлено примеров — ${res.learnedExchanges}, правил в плейбуке — ${res.playbookSize}.`,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : ''
        if (msg === 'no_dialogs') {
          toast.error('У этого аккаунта нет диалогов с двусторонней перепиской')
        } else {
          toast.error('Не удалось обучить ИИ на аккаунте')
        }
      }
    })
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary">
          <BrainCircuit className="size-5" />
        </div>
        <div className="flex-1">
          <p className="font-medium">Обучить ИИ на аккаунте</p>
          <p className="text-sm text-muted-foreground">
            Выберите аккаунт — ИИ полностью проанализирует переписки менеджера с
            клиентами, обучится их стилю и начнёт так же вести новых клиентов:
            дожимать, отрабатывать возражения и доводить до передачи документов.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select
          value={selected}
          onValueChange={(v) => setSelected(v ?? '')}
          disabled={loading || training || accounts.length === 0}
        >
          <SelectTrigger className="w-full sm:max-w-md">
            <SelectValue
              placeholder={
                loading ? 'Загрузка аккаунтов…' : 'Нет аккаунтов с диалогами'
              }
            />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((a) => (
              <SelectItem key={a.channelId} value={a.channelId}>
                {a.label} · {a.dialogCount} диал.
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          className="sm:ml-auto"
          disabled={!selected || training || loading}
          onClick={train}
        >
          {training ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <GraduationCap className="size-4" />
          )}
          Обучить
        </Button>
      </div>

      {training ? (
        <p className="text-sm text-primary">
          Анализирую переписки и обучаю ИИ… это может занять до минуты.
        </p>
      ) : null}
    </Card>
  )
}

function ChatBubble({ turn }: { turn: ChatTurn }) {
  const isClient = turn.role === 'client'
  return (
    <div className={isClient ? 'flex justify-start' : 'flex justify-end'}>
      <div
        className={
          isClient
            ? 'max-w-[80%] rounded-lg rounded-bl-sm bg-muted px-3 py-2 text-sm'
            : 'max-w-[80%] rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground'
        }
      >
        {turn.body}
      </div>
    </div>
  )
}
