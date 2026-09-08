'use client'

import type React from 'react'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  Check,
  FileText,
  ImageIcon,
  Loader2,
  MessagesSquare,
  Paperclip,
  Pencil,
  Reply,
  Send,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { VoiceRecorder } from '@/components/manager/inbox/voice-recorder'
import { usePersonalMessenger } from './use-personal-messenger'
import { usePooledDialogs } from './use-pooled-dialogs'
import { DialogAvatar, accountHue, dayLabel } from './messenger-shared'
import { DialogList } from './dialog-list'
import { MessageBubble } from './message-bubble'
import {
  personalDeleteDialogAction,
  type PersonalMessage,
  type PooledAccount,
  type PooledDialog,
} from '@/app/actions/admin-secret/telegram-personal'

/* ------------------------- Общий пул мессенджера ------------------------ */

/**
 * Единый мессенджер общего пула: диалоги ВСЕХ личных Telegram-аккаунтов в
 * одном списке (usePooledDialogs), помеченные аккаунтом-владельцем. Слева —
 * рельса-фильтр аккаунтов + поиск по всему пулу; выбранный чат открывается
 * через свой аккаунт (usePersonalMessenger — движок треда одного канала).
 * Шапка треда всегда показывает, ЧЕРЕЗ КАКОЙ профиль ведётся переписка.
 */
export function PersonalMessenger({
  accounts,
  unread,
  initialFilter,
  onBack,
}: {
  /** Все личные аккаунты — для рельсы-фильтра и контекста. */
  accounts: PooledAccount[]
  /** id аккаунта -> непрочитанных всего (бейджи в рельсе). */
  unread: Record<string, number>
  /** Начальный фильтр: 'all' или id аккаунта (клик по карточке). */
  initialFilter: string
  onBack: () => void
}) {
  const pool = usePooledDialogs()
  const [filter, setFilter] = useState(initialFilter)
  const [selected, setSelected] = useState<{
    accountId: string
    peerId: string
  } | null>(null)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<PersonalMessage | null>(null)
  const [editing, setEditing] = useState<PersonalMessage | null>(null)
  const [pendingFile, setPendingFile] = useState<{
    dataB64: string
    name: string
    mime: string | null
    asPhoto: boolean
    previewUrl: string | null
  } | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Движок треда одного канала. Список диалогов этого хука не используем —
  // список берём из общего пула; но send/edit/delete/history этого канала
  // работают через него (скоуп по выбранному аккаунту).
  const activeChannelId = selected?.accountId ?? null
  const m = usePersonalMessenger(activeChannelId)

  const activeAccount = useMemo<PooledAccount | null>(
    () => accounts.find((a) => a.id === selected?.accountId) ?? null,
    [accounts, selected?.accountId],
  )

  /* ---- Скролл по намерению (тот же паттерн, что use-thread-scroll) ---- */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const programmaticRef = useRef(false)
  const [showJump, setShowJump] = useState(false)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current
    if (!el) return
    programmaticRef.current = true
    el.scrollTo({ top: el.scrollHeight, behavior })
    window.setTimeout(() => {
      programmaticRef.current = false
    }, 350)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stickRef.current = false
    }
    let touchY = 0
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0
      if (y > touchY + 4) stickRef.current = false
    }
    const onScroll = () => {
      if (programmaticRef.current) return
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight
      if (dist < 40) stickRef.current = true
      setShowJump(dist > 300)
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('scroll', onScroll)
    }
  }, [m.peer])

  const lastIdRef = useRef<string | null>(null)
  useEffect(() => {
    const last = m.messages[m.messages.length - 1]?.id ?? null
    if (last !== lastIdRef.current) {
      lastIdRef.current = last
      if (stickRef.current) scrollToBottom(m.threadLoading ? 'auto' : 'smooth')
    }
  }, [m.messages, m.threadLoading, scrollToBottom])

  useEffect(() => {
    if (!m.threadLoading && m.peer) {
      stickRef.current = true
      scrollToBottom('auto')
    }
  }, [m.threadLoading, m.peer, scrollToBottom])

  /* ------------------------------ Выбор чата --------------------------- */

  const activeDialog = useMemo<PooledDialog | null>(
    () =>
      pool.dialogs.find(
        (d) =>
          d.accountId === selected?.accountId && d.peerId === selected?.peerId,
      ) ?? null,
    [pool.dialogs, selected],
  )

  const filteredDialogs = useMemo(() => {
    const q = search.trim().toLowerCase()
    return pool.dialogs.filter((d) => {
      if (filter !== 'all' && d.accountId !== filter) return false
      if (!q) return true
      return (
        d.title.toLowerCase().includes(q) ||
        (d.username ?? '').toLowerCase().includes(q) ||
        d.accountName.toLowerCase().includes(q)
      )
    })
  }, [pool.dialogs, filter, search])

  const selectDialog = useCallback(
    (d: PooledDialog) => {
      setSelected({ accountId: d.accountId, peerId: d.peerId })
      m.setPeer(d.peerId)
      pool.markRead(d.accountId, d.peerId)
      setReplyTo(null)
      setEditing(null)
      setPendingFile((prev) => {
        if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl)
        return null
      })
      setDraft('')
    },
    [m, pool],
  )

  const closeThread = useCallback(() => {
    m.setPeer(null)
    setSelected(null)
  }, [m])

  const handleDeleteDialog = useCallback(
    async (accountId: string, peerId: string, revoke: boolean) => {
      const res = await personalDeleteDialogAction(accountId, peerId, revoke)
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      pool.removeDialog(accountId, peerId)
      if (selected?.accountId === accountId && selected?.peerId === peerId) {
        closeThread()
      }
      toast.success('Диалог удалён')
    },
    [pool, selected, closeThread],
  )

  /* ------------------------------ Отправка ----------------------------- */

  const handleSend = useCallback(async () => {
    const text = draft.trim()
    if (editing) {
      if (!text) return
      const ok = await m.editMessage(Number(editing.id), text)
      if (ok) {
        setEditing(null)
        setDraft('')
      }
      return
    }
    if (pendingFile) {
      const ok = await m.sendFile({
        dataB64: pendingFile.dataB64,
        name: pendingFile.name,
        mime: pendingFile.mime,
        asPhoto: pendingFile.asPhoto,
        caption: text || undefined,
        replyToMsgId: replyTo ? Number(replyTo.id) : undefined,
      })
      if (ok) {
        if (pendingFile.previewUrl) URL.revokeObjectURL(pendingFile.previewUrl)
        setPendingFile(null)
        setReplyTo(null)
        setDraft('')
        stickRef.current = true
      }
      return
    }
    if (!text) return
    const ok = await m.sendText(text, replyTo ? Number(replyTo.id) : undefined)
    if (ok) {
      setDraft('')
      setReplyTo(null)
      stickRef.current = true
    }
  }, [draft, editing, pendingFile, replyTo, m])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== 'Enter' || e.shiftKey) return
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      e.preventDefault()
      void handleSend()
    },
    [handleSend],
  )

  const handlePickFile = useCallback((asPhoto: boolean) => {
    const input = fileInputRef.current
    if (!input) return
    input.accept = asPhoto ? 'image/*' : '*/*'
    input.dataset.asPhoto = asPhoto ? '1' : ''
    input.click()
  }, [])

  const handleFileChosen = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      const asPhoto = Boolean(e.target.dataset.asPhoto)
      e.target.value = ''
      if (!file) return
      if (file.size > 15 * 1024 * 1024) {
        alert('Файл больше 15 МБ — отправьте его с телефона.')
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result ?? '')
        const dataB64 = result.slice(result.indexOf(',') + 1)
        setPendingFile((prev) => {
          if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl)
          return {
            dataB64,
            name: file.name,
            mime: file.type || null,
            asPhoto: asPhoto && file.type.startsWith('image/'),
            previewUrl: file.type.startsWith('image/')
              ? URL.createObjectURL(file)
              : null,
          }
        })
        setEditing(null)
      }
      reader.readAsDataURL(file)
    },
    [],
  )

  const startEdit = useCallback((msg: PersonalMessage) => {
    setEditing(msg)
    setReplyTo(null)
    setPendingFile((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl)
      return null
    })
    setDraft(msg.text)
  }, [])

  const cancelComposerExtras = useCallback(() => {
    setEditing(null)
    setReplyTo(null)
    setPendingFile((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl)
      return null
    })
    setDraft('')
  }, [])

  /* ------------------------- Группировка по дням ------------------------ */

  const grouped = useMemo(() => {
    const out: { day: string; items: PersonalMessage[] }[] = []
    for (const msg of m.messages) {
      const day = dayLabel(msg.date)
      const last = out[out.length - 1]
      if (last && last.day === day) last.items.push(msg)
      else out.push({ day, items: [msg] })
    }
    return out
  }, [m.messages])

  const repliedTo = useCallback(
    (id: string | null): PersonalMessage | null =>
      id ? (m.messages.find((x) => x.id === id) ?? null) : null,
    [m.messages],
  )

  const threadChannelId = selected?.accountId ?? ''

  /* -------------------------------- Рендер ------------------------------ */

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded-xl border border-border bg-card">
      {/* Список диалогов общего пула */}
      <DialogList
        accounts={accounts}
        unread={unread}
        filter={filter}
        onFilterChange={(v) => {
          setFilter(v)
          setSearch('')
        }}
        search={search}
        onSearchChange={setSearch}
        dialogs={filteredDialogs}
        loading={pool.loading}
        error={pool.error}
        selectedAccountId={selected?.accountId ?? null}
        selectedPeerId={selected?.peerId ?? null}
        onSelect={selectDialog}
        onDeleteDialog={(accountId, peerId, revoke) =>
          void handleDeleteDialog(accountId, peerId, revoke)
        }
        onBack={onBack}
        peerOpen={Boolean(selected)}
      />

      {/* Тред */}
      <section
        className={cn(
          'flex min-w-0 flex-1 flex-col',
          !selected && 'hidden md:flex',
        )}
      >
        {!selected || !activeDialog ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-muted/40 px-6 text-center">
            <span className="flex size-16 items-center justify-center rounded-full bg-background shadow-sm ring-1 ring-border/60">
              <MessagesSquare className="size-7 text-muted-foreground" />
            </span>
            <p className="max-w-56 text-sm text-muted-foreground text-pretty">
              Выберите диалог слева, чтобы открыть переписку
            </p>
          </div>
        ) : (
          <>
            {/* Шапка треда — с контекстом профиля */}
            <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2.5">
              <Button
                variant="ghost"
                size="icon"
                className="size-8 md:hidden"
                onClick={closeThread}
                aria-label="Назад к диалогам"
              >
                <ArrowLeft className="size-4" />
              </Button>
              <DialogAvatar
                channelId={threadChannelId}
                dialog={activeDialog}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {activeDialog.title}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {activeDialog.username
                    ? `@${activeDialog.username}`
                    : activeDialog.kind === 'user'
                      ? 'Личный чат'
                      : activeDialog.kind === 'group'
                        ? 'Группа'
                        : 'Канал'}
                </p>
              </div>
              {/* Через какой профиль ведётся переписка */}
              <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1">
                <span
                  className={cn(
                    'size-2 rounded-full',
                    accountHue(activeDialog.accountId),
                  )}
                  aria-hidden
                />
                <span className="max-w-32 truncate text-xs font-medium text-muted-foreground">
                  {activeAccount?.name ?? activeDialog.accountName}
                </span>
              </span>
            </div>

            {/* Сообщения */}
            <div
              ref={scrollRef}
              className="relative min-h-0 flex-1 overflow-y-auto bg-muted/40 px-4 py-3"
            >
              {m.threadLoading ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              ) : (
                <>
                  {m.hasMore && (
                    <div className="mb-3 flex justify-center">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs bg-transparent"
                        disabled={m.loadingOlder}
                        onClick={() => void m.loadOlder()}
                      >
                        {m.loadingOlder ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          'Показать более ранние'
                        )}
                      </Button>
                    </div>
                  )}
                  {grouped.map((group) => (
                    <div key={group.day}>
                      <div className="sticky top-0 z-10 my-3 flex justify-center">
                        <span className="rounded-full bg-background/80 px-3 py-0.5 text-[11px] font-medium text-muted-foreground shadow-sm ring-1 ring-border/50 backdrop-blur">
                          {group.day}
                        </span>
                      </div>
                      <div className="flex flex-col">
                        {group.items.map((msg, j) => {
                          const prev = group.items[j - 1]
                          const next = group.items[j + 1]
                          const sameAsPrev =
                            !!prev &&
                            prev.outgoing === msg.outgoing &&
                            msg.date - prev.date < 300
                          const sameAsNext =
                            !!next &&
                            next.outgoing === msg.outgoing &&
                            next.date - msg.date < 300
                          return (
                            <MessageBubble
                              key={msg.id}
                              msg={msg}
                              reply={repliedTo(msg.replyToId)}
                              channelId={threadChannelId}
                              peerId={activeDialog.peerId}
                              tight={sameAsPrev}
                              showTail={!sameAsNext}
                              onReply={(target) => {
                                setReplyTo(target)
                                setEditing(null)
                              }}
                              onEdit={startEdit}
                              onDelete={(target) => {
                                if (confirm('Удалить сообщение у всех?')) {
                                  void m.deleteMessage(Number(target.id))
                                }
                              }}
                            />
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </>
              )}
              {showJump && (
                <Button
                  variant="secondary"
                  size="icon"
                  className="sticky bottom-2 left-full size-9 rounded-full border border-border bg-card shadow-md ring-1 ring-border/50 hover:bg-muted"
                  aria-label="Вниз"
                  onClick={() => {
                    stickRef.current = true
                    scrollToBottom('smooth')
                  }}
                >
                  <ArrowDown className="size-4" />
                </Button>
              )}
            </div>

            {/* Композер */}
            <div className="border-t border-border bg-card p-3">
              {(replyTo || editing || pendingFile) && (
                <div className="mb-2 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs">
                  {editing ? (
                    <>
                      <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        Редактирование: {editing.text}
                      </span>
                    </>
                  ) : replyTo ? (
                    <>
                      <Reply className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        Ответ: {replyTo.text || 'Вложение'}
                      </span>
                    </>
                  ) : null}
                  {pendingFile && (
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      {pendingFile.previewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={pendingFile.previewUrl || '/placeholder.svg'}
                          alt=""
                          className="size-8 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate text-muted-foreground">
                        {pendingFile.name}
                      </span>
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0"
                    aria-label="Отменить"
                    onClick={cancelComposerExtras}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              )}
              <div className="flex items-end gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-9 shrink-0"
                        aria-label="Прикрепить"
                        disabled={Boolean(editing)}
                      >
                        <Paperclip className="size-4" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="start" side="top">
                    <DropdownMenuItem onClick={() => handlePickFile(true)}>
                      <ImageIcon className="size-4" />
                      Фото
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handlePickFile(false)}>
                      <FileText className="size-4" />
                      Файл
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="sr-only"
                  aria-hidden="true"
                  tabIndex={-1}
                  onChange={handleFileChosen}
                />
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    editing
                      ? 'Изменить сообщение…'
                      : pendingFile
                        ? 'Подпись (необязательно)…'
                        : 'Сообщение…'
                  }
                  rows={1}
                  className="max-h-36 min-h-9 flex-1 resize-none"
                />
                {draft.trim() || pendingFile || editing ? (
                  <Button
                    size="icon"
                    className="size-9 shrink-0"
                    aria-label={editing ? 'Сохранить' : 'Отправить'}
                    disabled={m.sending}
                    onClick={() => void handleSend()}
                  >
                    {m.sending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : editing ? (
                      <Check className="size-4" />
                    ) : (
                      <Send className="size-4" />
                    )}
                  </Button>
                ) : (
                  <VoiceRecorder
                    disabled={m.sending}
                    onSend={(audio) => {
                      void m.sendVoice(audio.base64, audio.durationSec)
                      stickRef.current = true
                    }}
                    onError={(message) => toast.error(message)}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
