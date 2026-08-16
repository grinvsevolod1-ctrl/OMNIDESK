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
  Paperclip,
  Pencil,
  Reply,
  Search,
  Send,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { VoiceRecorder } from '@/components/manager/inbox/voice-recorder'
import { usePersonalMessenger } from './use-personal-messenger'
import {
  DialogAvatar,
  dayLabel,
  formatDialogTime,
} from './messenger-shared'
import { MessageBubble } from './message-bubble'
import type { PersonalMessage } from '@/app/actions/admin-secret/telegram-personal'

/* ------------------------------ Мессенджер ------------------------------ */

export function PersonalMessenger({
  channelId,
  accountName,
  onBack,
}: {
  channelId: string
  accountName: string
  onBack: () => void
}) {
  const m = usePersonalMessenger(channelId)
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

  // Пользовательский жест вверх мгновенно снимает прилипание.
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

  // Новые сообщения: скроллим вниз только если прилипание активно.
  const lastIdRef = useRef<string | null>(null)
  useEffect(() => {
    const last = m.messages[m.messages.length - 1]?.id ?? null
    if (last !== lastIdRef.current) {
      lastIdRef.current = last
      if (stickRef.current) scrollToBottom(m.threadLoading ? 'auto' : 'smooth')
    }
  }, [m.messages, m.threadLoading, scrollToBottom])

  // Открытие треда: всегда вниз.
  useEffect(() => {
    if (!m.threadLoading && m.peer) {
      stickRef.current = true
      scrollToBottom('auto')
    }
  }, [m.threadLoading, m.peer, scrollToBottom])

  /* ------------------------------ Отправка ----------------------------- */

  const activeDialog = useMemo(
    () => m.dialogs.find((d) => d.peerId === m.peer) ?? null,
    [m.dialogs, m.peer],
  )

  const filteredDialogs = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return m.dialogs
    return m.dialogs.filter(
      (d) =>
        d.title.toLowerCase().includes(q) ||
        (d.username ?? '').toLowerCase().includes(q),
    )
  }, [m.dialogs, search])

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
      // CJK IME: Enter подтверждает композицию, не отправляем.
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
        // Лимит server action; крупные файлы — с телефона.
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

  /* -------------------------------- Рендер ------------------------------ */

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded-xl border border-border bg-card">
      {/* Список диалогов */}
      <aside
        className={cn(
          'flex w-full shrink-0 flex-col border-r border-border md:w-80',
          m.peer && 'hidden md:flex',
        )}
      >
        <div className="flex items-center gap-2 border-b border-border p-3">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            onClick={onBack}
            aria-label="К списку аккаунтов"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{accountName}</p>
            <p className="text-xs text-muted-foreground">Личный аккаунт</p>
          </div>
        </div>
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск диалогов"
              className="h-9 pl-8"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {m.dialogsLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : m.dialogsError ? (
            <p className="p-4 text-sm text-muted-foreground">{m.dialogsError}</p>
          ) : filteredDialogs.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {search ? 'Ничего не найдено.' : 'Диалогов пока нет.'}
            </p>
          ) : (
            filteredDialogs.map((d) => (
              <button
                key={d.peerId}
                type="button"
                onClick={() => m.setPeer(d.peerId)}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60',
                  m.peer === d.peerId && 'bg-muted',
                )}
              >
                <DialogAvatar channelId={channelId} dialog={d} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-sm font-medium">{d.title}</p>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {formatDialogTime(d.lastMessageAt)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs text-muted-foreground">
                      {d.lastOutgoing && (
                        <span className="mr-1 text-muted-foreground/70">Вы:</span>
                      )}
                      {d.lastMessage || '—'}
                    </p>
                    {d.unreadCount > 0 && (
                      <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
                        {d.unreadCount > 99 ? '99+' : d.unreadCount}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Тред */}
      <section className={cn('flex min-w-0 flex-1 flex-col', !m.peer && 'hidden md:flex')}>
        {!m.peer || !activeDialog ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Выберите диалог, чтобы начать общение
            </p>
          </div>
        ) : (
          <>
            {/* Шапка треда */}
            <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
              <Button
                variant="ghost"
                size="icon"
                className="size-8 md:hidden"
                onClick={() => m.setPeer(null)}
                aria-label="Назад к диалогам"
              >
                <ArrowLeft className="size-4" />
              </Button>
              <DialogAvatar channelId={channelId} dialog={activeDialog} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{activeDialog.title}</p>
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
            </div>

            {/* Сообщения */}
            <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto px-4 py-3">
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
                      <div className="my-3 flex justify-center">
                        <span className="rounded-full bg-muted px-3 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {group.day}
                        </span>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {group.items.map((msg) => (
                          <MessageBubble
                            key={msg.id}
                            msg={msg}
                            reply={repliedTo(msg.replyToId)}
                            channelId={channelId}
                            peerId={activeDialog.peerId}
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
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              )}
              {showJump && (
                <Button
                  variant="secondary"
                  size="icon"
                  className="sticky bottom-2 left-full size-9 rounded-full shadow-md"
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
            <div className="border-t border-border p-3">
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
                          src={pendingFile.previewUrl || "/placeholder.svg"}
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
