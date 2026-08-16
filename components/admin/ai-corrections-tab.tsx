'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import {
  ArrowLeft,
  Ban,
  Bot,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Save,
  Trash2,
  User,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  aiAddCorrectionAction,
  aiDeleteCorrectionAction,
  aiListCorrectionsAction,
  aiReviewDialogsAction,
  aiReviewMessagesAction,
  aiTrainableAccountsAction,
} from '@/app/actions/ai-assist'
import type {
  ManualCorrection,
  ReviewDialog,
  ReviewMessage,
  TrainableAccount,
} from '@/lib/data/ai-assist'
import { Badge } from '@/components/ui/badge'
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

/**
 * "Правки" tab: the operator opens a real account, loads the dialogs where a
 * conversation actually happened, opens one, selects ANY message (client, AI or
 * manager) and writes what was wrong and how it should have been handled. Each
 * note is stored forever as a strict, always-injected correction the AI can
 * never forget or repeat.
 */
export function AiCorrectionsTab() {
  const [accounts, setAccounts] = useState<TrainableAccount[]>([])
  const [channelId, setChannelId] = useState('')
  const [loadingAccounts, startLoadAccounts] = useTransition()

  const [dialogs, setDialogs] = useState<ReviewDialog[]>([])
  const [loadingDialogs, startLoadDialogs] = useTransition()

  const [activeDialog, setActiveDialog] = useState<ReviewDialog | null>(null)
  const [messages, setMessages] = useState<ReviewMessage[]>([])
  const [loadingMessages, startLoadMessages] = useTransition()

  const [corrections, setCorrections] = useState<ManualCorrection[]>([])
  const [correctionCount, setCorrectionCount] = useState(0)

  const accountLabel =
    accounts.find((a) => a.channelId === channelId)?.label ?? ''

  // Load accounts + existing corrections once.
  useEffect(() => {
    startLoadAccounts(async () => {
      try {
        const list = await aiTrainableAccountsAction()
        setAccounts(list)
        if (list.length > 0) setChannelId(list[0].channelId)
      } catch {
        // empty state handles it
      }
    })
    void aiListCorrectionsAction()
      .then((r) => {
        setCorrections(r.corrections)
        setCorrectionCount(r.count)
      })
      .catch(() => {})
  }, [])

  const loadDialogs = useCallback(() => {
    if (!channelId) return
    setActiveDialog(null)
    setMessages([])
    startLoadDialogs(async () => {
      try {
        const list = await aiReviewDialogsAction({ channelId })
        setDialogs(list)
        if (list.length === 0) toast.info('У этого аккаунта нет диалогов с перепиской')
      } catch {
        toast.error('Не удалось загрузить диалоги')
      }
    })
  }, [channelId])

  const openDialog = useCallback(
    (d: ReviewDialog) => {
      setActiveDialog(d)
      setMessages([])
      startLoadMessages(async () => {
        try {
          const list = await aiReviewMessagesAction({
            channelId,
            conversationId: d.conversationId,
          })
          setMessages(list)
        } catch {
          toast.error('Не удалось открыть диалог')
        }
      })
    },
    [channelId],
  )

  const onSaved = useCallback((next: ManualCorrection[], count: number) => {
    setCorrections(next)
    setCorrectionCount(count)
  }, [])

  const removeCorrection = useCallback((id: string) => {
    void aiDeleteCorrectionAction({ id })
      .then((r) => {
        setCorrections(r.corrections)
        setCorrectionCount(r.count)
        toast.success('Правка удалена')
      })
      .catch(() => toast.error('Не удалось удалить'))
  }, [])

  return (
    <div className="flex flex-col gap-4">
      {/* Account picker + load */}
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary">
            <MessageSquareText className="size-5" />
          </div>
          <div className="flex-1">
            <p className="font-medium">Правки по сообщениям</p>
            <p className="text-sm text-muted-foreground">
              Выберите аккаунт и загрузите диалоги. Откройте переписку, нажмите на
              любое сообщение и напишите, что было не так и как правильно. ИИ
              запомнит это навсегда и больше не повторит ошибку.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            value={channelId}
            onValueChange={(v) => setChannelId(v ?? '')}
            disabled={loadingAccounts || accounts.length === 0}
          >
            <SelectTrigger className="w-full sm:max-w-md">
              <SelectValue
                placeholder={
                  loadingAccounts ? 'Загрузка аккаунтов…' : 'Нет аккаунтов'
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
            variant="outline"
            disabled={!channelId || loadingDialogs}
            onClick={loadDialogs}
          >
            {loadingDialogs ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Загрузить диалоги
          </Button>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Left: dialog list OR the opened conversation */}
        <Card className="flex flex-col gap-3 p-4">
          {!activeDialog ? (
            <>
              <p className="font-medium">
                Диалоги{' '}
                {dialogs.length > 0 ? (
                  <span className="text-sm font-normal text-muted-foreground">
                    ({dialogs.length})
                  </span>
                ) : null}
              </p>
              <Separator />
              {dialogs.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Нажмите «Загрузить диалоги», чтобы увидеть переписки этого
                  аккаунта.
                </p>
              ) : (
                <div className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto">
                  {dialogs.map((d) => (
                    <button
                      key={d.conversationId}
                      onClick={() => openDialog(d)}
                      className="press-scale flex items-center justify-between gap-2 rounded-md border border-border p-3 text-left text-sm transition-colors hover:bg-muted"
                    >
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        {d.contactName}
                      </span>
                      {d.aiLed ? (
                        <Badge variant="secondary" className="shrink-0">
                          ИИ
                        </Badge>
                      ) : null}
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {d.messageCount} сообщ.
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <ConversationReview
              dialog={activeDialog}
              messages={messages}
              loading={loadingMessages}
              channelId={channelId}
              accountLabel={accountLabel}
              onBack={() => {
                setActiveDialog(null)
                setMessages([])
              }}
              onSaved={onSaved}
            />
          )}
        </Card>

        {/* Right: saved corrections */}
        <Card className="flex flex-col gap-3 p-4">
          <p className="font-medium">
            Сохранённые правки{' '}
            <span className="text-sm font-normal text-muted-foreground">
              ({correctionCount})
            </span>
          </p>
          <Separator />
          {corrections.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Пока нет правок. Откройте диалог, выберите сообщение и объясните,
              как надо было — ИИ запомнит это навсегда.
            </p>
          ) : (
            <div className="flex max-h-[32rem] flex-col gap-3 overflow-y-auto">
              {corrections.map((c) => (
                <div
                  key={c.id}
                  className="flex flex-col gap-1.5 rounded-md border border-border p-3 text-sm"
                >
                  {c.targetMessage ? (
                    <p className="text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {c.targetRole === 'client'
                          ? 'Клиент'
                          : c.targetRole === 'manager'
                            ? 'Менеджер'
                            : 'ИИ'}
                        :
                      </span>{' '}
                      <span className="line-clamp-2">{c.targetMessage}</span>
                    </p>
                  ) : null}
                  <p>
                    <span className="font-medium text-primary">Правило:</span>{' '}
                    {c.instruction}
                  </p>
                  {c.accountLabel ? (
                    <p className="text-xs text-muted-foreground">
                      {c.accountLabel}
                    </p>
                  ) : null}
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeCorrection(c.id)}
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

/* ------------------------- Opened conversation view ----------------------- */

function ConversationReview({
  dialog,
  messages,
  loading,
  channelId,
  accountLabel,
  onBack,
  onSaved,
}: {
  dialog: ReviewDialog
  messages: ReviewMessage[]
  loading: boolean
  channelId: string
  accountLabel: string
  onBack: () => void
  onSaved: (next: ManualCorrection[], count: number) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const [saving, startSave] = useTransition()
  const composerRef = useRef<HTMLDivElement | null>(null)

  const selected = messages.find((m) => m.id === selectedId) ?? null

  const pick = (id: string) => {
    setSelectedId(id)
    // Bring the composer into view on small screens.
    requestAnimationFrame(() =>
      composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
    )
  }

  const save = () => {
    if (!selected || !instruction.trim()) return
    startSave(async () => {
      try {
        const res = await aiAddCorrectionAction({
          channelId,
          conversationId: dialog.conversationId,
          messageId: selected.id,
          accountLabel,
          instruction: instruction.trim(),
        })
        onSaved(res.corrections, res.count)
        toast.success('Правка сохранена — ИИ запомнил это навсегда')
        setInstruction('')
        setSelectedId(null)
      } catch (err) {
        const msg = err instanceof Error ? err.message : ''
        if (msg === 'empty_instruction') {
          toast.error('Напишите, что именно было не так')
        } else {
          toast.error('Не удалось сохранить правку')
        }
      }
    })
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <p className="min-w-0 flex-1 truncate font-medium">
          {dialog.contactName}
        </p>
        {dialog.aiLed ? <Badge variant="secondary">ИИ ведёт</Badge> : null}
      </div>
      <Separator />

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : messages.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          В этом диалоге нет сообщений.
        </p>
      ) : (
        <div className="flex max-h-96 flex-col gap-2 overflow-y-auto rounded-md border border-border p-3">
          {messages.map((m) => (
            <SelectableBubble
              key={m.id}
              message={m}
              selected={m.id === selectedId}
              onSelect={() => pick(m.id)}
            />
          ))}
        </div>
      )}

      {selected ? (
        <div ref={composerRef} className="flex flex-col gap-2">
          <Label htmlFor="correction-note">
            Что было не так с этим сообщением и как правильно?
          </Label>
          <div className="rounded-md border border-primary/40 bg-primary/5 p-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {selected.role === 'client'
                ? 'Клиент'
                : selected.role === 'manager'
                  ? 'Менеджер'
                  : 'ИИ'}
              :
            </span>{' '}
            {selected.body}
          </div>
          <Textarea
            id="correction-note"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            placeholder="Например: здесь ты перевёл клиента на менеджера — так делать нельзя, ты сам менеджер. Нужно было отработать возражение и снова попросить документы."
          />
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setSelectedId(null)
                setInstruction('')
              }}
            >
              Отмена
            </Button>
            <Button onClick={save} disabled={!instruction.trim() || saving}>
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              Сохранить правку
            </Button>
          </div>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Ban className="size-3.5" />
          Нажмите на любое сообщение выше, чтобы оставить правку.
        </p>
      )}
    </>
  )
}

function SelectableBubble({
  message,
  selected,
  onSelect,
}: {
  message: ReviewMessage
  selected: boolean
  onSelect: () => void
}) {
  const isClient = message.role === 'client'
  const isAi = message.role === 'ai'
  return (
    <div className={isClient ? 'flex justify-start' : 'flex justify-end'}>
      <button
        onClick={onSelect}
        className={[
          'max-w-[85%] rounded-lg px-3 py-2 text-left text-sm transition-all',
          isClient
            ? 'rounded-bl-sm bg-muted'
            : 'rounded-br-sm bg-primary text-primary-foreground',
          selected ? 'ring-2 ring-offset-2 ring-offset-background ring-primary' : '',
        ].join(' ')}
      >
        <span className="mb-0.5 flex items-center gap-1 text-[10px] uppercase opacity-70">
          {isClient ? (
            <User className="size-3" />
          ) : (
            <Bot className="size-3" />
          )}
          {isClient ? 'Клиент' : isAi ? 'ИИ' : 'Менеджер'}
        </span>
        {message.body}
      </button>
    </div>
  )
}
