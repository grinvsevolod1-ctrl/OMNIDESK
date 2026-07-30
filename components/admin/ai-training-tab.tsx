'use client'

import {
  useEffect,
  useState,
  useTransition,
} from 'react'
import { toast } from 'sonner'
import {
  BrainCircuit,
  ChevronDown,
  GraduationCap,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
} from 'lucide-react'
import {
  aiDeleteLessonAction,
  aiSampleConversationsAction,
  aiSaveLessonAction,
  aiSuggestReplyAction,
  aiTrainOnAccountAction,
  aiTrainableAccountsAction,
} from '@/app/actions/ai-assist'
import {
  type AiAssistLesson,
  type TrainableAccount,
  type TrainingSample,
} from '@/lib/data/ai-assist'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/* ------------------------------- Training ------------------------------- */

type ChatTurn = { role: 'client' | 'manager'; body: string }

export function TrainingTab({
  lessons,
  onLessonsChange,
}: {
  lessons: AiAssistLesson[]
  onLessonsChange: (next: AiAssistLesson[]) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* Hero: the one-click way to teach the AI a whole account's style. */}
      <TrainOnAccountCard onLessonsChange={onLessonsChange} />

      {/* Optional manual per-dialog teaching, tucked away by default. */}
      <ManualTrainer onLessonsChange={onLessonsChange} />

      {/* The resulting lesson corpus. */}
      <LessonsCard lessons={lessons} onLessonsChange={onLessonsChange} />
    </div>
  )
}

/* -------------------------- Train on an account ------------------------- */

/**
 * Point the trainer at a real messaging account: the AI reads that account's
 * manager↔client dialogs, learns its selling style, stores the strongest
 * exchanges as lessons, and re-distills the playbook.
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
        const coverage =
          res.totalDialogs > res.dialogsAnalysed
            ? ` из ${res.totalDialogs} (взяты самые свежие; запустите ещё раз, чтобы добрать)`
            : ''
        toast.success(
          `Готово. Проанализировано диалогов — ${res.dialogsAnalysed}${coverage}, добавлено примеров — ${res.learnedExchanges}, правил в плейбуке — ${res.playbookSize}.`,
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
            Выберите аккаунт — ИИ разберёт переписки менеджеров с клиентами,
            переймёт их стиль и начнёт так же вести новых клиентов: дожимать,
            отрабатывать возражения и доводить до заявки.
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
        <p className="flex items-center gap-2 text-sm text-primary">
          <Loader2 className="size-4 animate-spin" />
          Анализирую переписки и обучаю ИИ… не закрывайте вкладку.
        </p>
      ) : null}
    </Card>
  )
}

/* ---------------------------- Manual trainer ---------------------------- */

/**
 * Optional fine-grained teaching: pick a real conversation, write/curate the
 * ideal manager reply, and save it as a lesson. Collapsed by default because
 * training on a whole account covers most needs.
 */
function ManualTrainer({
  onLessonsChange,
}: {
  onLessonsChange: (next: AiAssistLesson[]) => void
}) {
  const [open, setOpen] = useState(false)
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

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-muted/50"
      >
        <span className="flex items-center gap-3">
          <span className="rounded-md bg-muted p-2 text-muted-foreground">
            <Sparkles className="size-5" />
          </span>
          <span>
            <span className="block font-medium">Ручная тренировка</span>
            <span className="block text-sm text-muted-foreground">
              Обучение на отдельном диалоге — по желанию
            </span>
          </span>
        </span>
        <ChevronDown
          className={cn(
            'size-5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open ? (
        <div className="flex flex-col gap-4 border-t border-border p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Выберите переписку и сохраните образцовый ответ — он станет уроком.
            </p>
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
            <p className="py-6 text-center text-sm text-muted-foreground">
              Нажмите «Загрузить диалоги», чтобы выбрать реальную переписку.
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
        </div>
      ) : null}
    </Card>
  )
}

/* ------------------------------- Lessons -------------------------------- */

function LessonsCard({
  lessons,
  onLessonsChange,
}: {
  lessons: AiAssistLesson[]
  onLessonsChange: (next: AiAssistLesson[]) => void
}) {
  const [saving, startSave] = useTransition()

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
          Пока нет уроков. Обучите ИИ на аккаунте или сохраните ответ вручную —
          каждый пример делает его умнее.
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
                <p className="text-xs text-muted-foreground">{l.note}</p>
              ) : null}
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeLesson(l.id)}
                  disabled={saving}
                  aria-label="Удалить урок"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
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
