'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  BookOpen,
  Brain,
  Lightbulb,
  Loader2,
  MessageSquareQuote,
  Sparkles,
  TriangleAlert,
} from 'lucide-react'
import { simLearnAction } from '@/app/actions/client-sim'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import type { LearnedProfile } from '@/lib/client-sim/types'

export function SecretSimulatorLearn({
  initial,
}: {
  initial: LearnedProfile | null
}) {
  const [profile, setProfile] = useState<LearnedProfile | null>(initial)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function learn() {
    setError(null)
    startTransition(async () => {
      try {
        const res = await simLearnAction()
        if (res.ok) {
          setProfile(res.profile)
          toast.success('ИИ изучил диалоги')
        } else {
          setError(res.error)
          toast.error('Обучение не выполнено')
        }
      } catch {
        setError('Непредвиденная ошибка при обучении.')
        toast.error('Обучение не выполнено')
      }
    })
  }

  return (
    <Card className="flex flex-col gap-5 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40">
            <Brain className="size-5 text-foreground" />
          </div>
          <div>
            <h3 className="font-semibold tracking-tight">Обучение на реальных диалогах</h3>
            <p className="max-w-prose text-sm text-muted-foreground text-pretty">
              ИИ прочитает реальные переписки клиентов с менеджерами, поймёт их
              манеру, тон и типичные фразы — и будет писать заметно живее.
              Результат сохраняется и применяется ко всем новым диалогам.
            </p>
          </div>
        </div>
        <Button
          className="press-scale shrink-0 gap-2"
          onClick={learn}
          disabled={pending}
        >
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Изучаю…
            </>
          ) : (
            <>
              <Sparkles className="size-4" />
              {profile ? 'Обучить заново' : 'Изучить все диалоги'}
            </>
          )}
        </Button>
      </div>

      {pending && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <Loader2 className="size-4 shrink-0 animate-spin" />
          Читаю реальные переписки и анализирую стиль общения…
        </div>
      )}

      {error && !pending && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="text-pretty">{error}</span>
        </div>
      )}

      {profile && !pending && <LearnedReport profile={profile} />}
    </Card>
  )
}

function LearnedReport({ profile }: { profile: LearnedProfile }) {
  const when = new Date(profile.learnedAt)
  const whenStr = Number.isNaN(when.getTime())
    ? ''
    : when.toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })

  return (
    <div className="flex flex-col gap-5 border-t border-border pt-4">
      {/* Meta */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Stat label="Диалогов изучено" value={profile.dialogueCount} />
        <Stat label="Сообщений прочитано" value={profile.messageCount} />
        <Stat label="Каналов" value={profile.channels.length || '—'} />
        {whenStr && (
          <span className="ml-auto text-muted-foreground">Обновлено: {whenStr}</span>
        )}
      </div>

      {/* Summary */}
      {profile.summary && (
        <div className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/5 p-3">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-success" />
          <p className="text-sm text-pretty leading-relaxed">{profile.summary}</p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Section icon={Lightbulb} title="Что понял про тон" items={profile.toneNotes} />
        <Section icon={BookOpen} title="О чём обычно пишут" items={profile.commonTopics} />
      </div>

      <Section
        icon={Brain}
        title="Как теперь будет писать"
        items={profile.stylePointers}
        accent
      />

      {profile.samplePhrases.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <MessageSquareQuote className="size-4 text-muted-foreground" />
            Характерные фразы клиентов
          </div>
          <div className="flex flex-wrap gap-2">
            {profile.samplePhrases.map((p, i) => (
              <span
                key={i}
                className="rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground"
              >
                {p}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1">
      <span className="font-semibold tabular-nums">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}

function Section({
  icon: Icon,
  title,
  items,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  items: string[]
  accent?: boolean
}) {
  if (!items || items.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" />
        {title}
      </div>
      <ul className="flex flex-col gap-1.5">
        {items.map((it, i) => (
          <li
            key={i}
            className={
              accent
                ? 'flex items-start gap-2 rounded-md border border-border bg-muted/30 p-2 text-sm'
                : 'flex items-start gap-2 text-sm text-muted-foreground'
            }
          >
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/40" />
            <span className="text-pretty leading-relaxed">{it}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
