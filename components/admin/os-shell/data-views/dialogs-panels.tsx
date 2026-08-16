'use client'

/**
 * Conversation-facing panels: the dialog list (row click opens the
 * transcript), the chat-style transcript itself, and per-manager activity
 * (row click drills into that manager's dialogs).
 */

import {
  asArray,
  CHANNEL_LABEL,
  EmptyNote,
  formatWhen,
  Num,
  SimpleTable,
} from './shared'

interface DialogRow {
  id: string
  contactName: string
  channelType: string
  managerName: string | null
  lastMessage: string
  lastMessageAt: string
  unread: number
}

export function DialogsPanel({
  payload,
  onCommand,
}: {
  payload: unknown
  onCommand?: (prompt: string) => void
}) {
  const rows = asArray<DialogRow>(payload).filter((r) => r?.id)
  if (rows.length === 0) return <EmptyNote />
  return (
    <SimpleTable
      head={['Контакт', 'Канал', 'Менеджер', 'Последнее сообщение', 'Когда']}
      onRowClick={
        onCommand
          ? (i) =>
              onCommand(
                `Покажи переписку с «${rows[i].contactName}» (диалог ${rows[i].id})`,
              )
          : undefined
      }
      rows={rows.map((d) => [
        <span key="c" className="font-medium">
          {d.contactName}
          {d.unread > 0 ? (
            <span className="ml-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {d.unread}
            </span>
          ) : null}
        </span>,
        CHANNEL_LABEL[d.channelType] ?? d.channelType,
        d.managerName ?? '—',
        <span key="m" className="text-muted-foreground">
          {d.lastMessage || '—'}
        </span>,
        <span key="t" className="whitespace-nowrap text-xs text-muted-foreground">
          {formatWhen(d.lastMessageAt)}
        </span>,
      ])}
    />
  )
}

interface TranscriptMessage {
  direction: 'in' | 'out'
  author: string
  body: string
  createdAt: string
}

export function MessagesPanel({ payload }: { payload: unknown }) {
  const obj = (payload ?? {}) as {
    contactName?: string
    managerName?: string | null
    messages?: unknown
  }
  const messages = asArray<TranscriptMessage>(obj.messages).filter(
    (m) => m?.body || m?.author,
  )
  if (messages.length === 0) return <EmptyNote />
  return (
    <div className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
      {messages.map((m, i) => (
        <div
          key={i}
          className={
            m.direction === 'in'
              ? 'flex flex-col items-start'
              : 'flex flex-col items-end'
          }
        >
          <div
            className={
              m.direction === 'in'
                ? 'max-w-[85%] rounded-lg rounded-tl-sm border border-border bg-background/50 px-3 py-1.5'
                : 'max-w-[85%] rounded-lg rounded-tr-sm bg-primary/15 px-3 py-1.5'
            }
          >
            <p className="text-[11px] font-medium text-muted-foreground">
              {m.author}
            </p>
            <p className="whitespace-pre-wrap text-sm">{m.body}</p>
          </div>
          <span className="mt-0.5 text-[10px] text-muted-foreground">
            {formatWhen(m.createdAt)}
          </span>
        </div>
      ))}
    </div>
  )
}

interface ManagerActivityViewRow {
  id: string
  name: string
  status: string
  dialogsTotal: number
  newDialogs: number
  contactsWrote: number
  inboundMessages: number
  unanswered: number
}

export function ManagerActivityPanel({
  payload,
  onCommand,
}: {
  payload: unknown
  onCommand?: (prompt: string) => void
}) {
  const rows = asArray<ManagerActivityViewRow>(payload).filter((r) => r?.id)
  if (rows.length === 0) return <EmptyNote />
  return (
    <SimpleTable
      onRowClick={
        onCommand
          ? (i) => onCommand(`Покажи диалоги менеджера ${rows[i].name}`)
          : undefined
      }
      head={[
        'Менеджер',
        'Написало людей',
        'Входящих',
        'Новых диалогов',
        'Без ответа',
        'Всего диалогов',
      ]}
      rows={rows.map((m) => [
        <span key="n" className="font-medium">
          {m.name}
          {m.status !== 'active' ? (
            <span className="ml-1.5 text-xs text-muted-foreground">
              (заблокирован)
            </span>
          ) : null}
        </span>,
        <Num key="a" v={m.contactsWrote} highlight />,
        <Num key="b" v={m.inboundMessages} />,
        <Num key="c" v={m.newDialogs} />,
        <Num key="d" v={m.unanswered} warn={m.unanswered > 0} />,
        <Num key="e" v={m.dialogsTotal} />,
      ])}
    />
  )
}
