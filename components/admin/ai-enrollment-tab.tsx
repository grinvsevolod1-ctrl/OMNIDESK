'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { Bot, Loader2, Plus, RefreshCw, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  aiEnrollAction,
  aiListEnrollableAction,
  aiListEnrolledAction,
  aiUnenrollAction,
} from '@/app/actions/ai-assist'
import type { EnrollableConversation } from '@/lib/data/ai-assist'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'

const CHANNEL_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  vk: 'ВКонтакте',
  max: 'MAX',
  livechat: 'Онлайн-чат',
}

function channelLabel(type: string): string {
  return CHANNEL_LABEL[type] ?? type
}

/**
 * AI-lead control surface. New dialogs are led by the AI automatically (they
 * are enrolled at creation), so this screen is about EXCEPTIONS:
 *   - the left list shows every dialog the AI is currently leading, where the
 *     admin can switch the AI off for a specific conversation;
 *   - the right list shows dialogs the AI is NOT leading (older dialogs that
 *     predate auto-lead, or ones switched off here) so the admin can turn it
 *     back on.
 * There is deliberately no "enable everywhere" / "disable everywhere" switch.
 */
export function AiEnrollmentTab() {
  const [enrolled, setEnrolled] = useState<EnrollableConversation[]>([])
  const [candidates, setCandidates] = useState<EnrollableConversation[]>([])
  const [search, setSearch] = useState('')
  const [loadingEnrolled, startLoadEnrolled] = useTransition()
  const [loadingCandidates, startLoadCandidates] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)

  const refreshEnrolled = useCallback(() => {
    startLoadEnrolled(async () => {
      try {
        setEnrolled(await aiListEnrolledAction())
      } catch {
        toast.error('Не удалось загрузить список диалогов под ИИ')
      }
    })
  }, [])

  const searchCandidates = useCallback((q: string) => {
    startLoadCandidates(async () => {
      try {
        setCandidates(await aiListEnrollableAction({ search: q }))
      } catch {
        toast.error('Не удалось загрузить диалоги')
      }
    })
  }, [])

  // Initial load of the enrolled list + a first page of candidates.
  useEffect(() => {
    refreshEnrolled()
    searchCandidates('')
  }, [refreshEnrolled, searchCandidates])

  // Debounced search as the admin types.
  useEffect(() => {
    const t = setTimeout(() => searchCandidates(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search, searchCandidates])

  const enroll = async (id: string) => {
    setBusyId(id)
    try {
      const { enrolled: next, ok } = await aiEnrollAction({ conversationId: id })
      if (!ok) {
        toast.error('Диалог не найден — обновите список и попробуйте снова')
      } else {
        setEnrolled(next)
        toast.success('ИИ включён в диалоге')
        searchCandidates(search.trim())
      }
    } catch {
      toast.error('Не удалось подключить ИИ')
    } finally {
      setBusyId(null)
    }
  }

  const unenroll = async (id: string) => {
    setBusyId(id)
    try {
      const { enrolled: next } = await aiUnenrollAction({ conversationId: id })
      setEnrolled(next)
      toast.success('ИИ отключён от диалога')
      searchCandidates(search.trim())
    } catch {
      toast.error('Не удалось отключить ИИ')
    } finally {
      setBusyId(null)
    }
  }

  const enrolledIds = new Set(enrolled.map((c) => c.conversationId))
  const available = candidates.filter((c) => !enrolledIds.has(c.conversationId))

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex items-start gap-3 border-primary/30 bg-primary/5 p-4">
        <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary">
          <Bot className="size-5" />
        </div>
        <div className="text-sm">
          <p className="font-medium">
            ИИ автоматически ведёт все новые диалоги
          </p>
          <p className="text-muted-foreground">
            Каждый новый диалог сразу берёт на себя ИИ — вручную включать ничего
            не нужно. Здесь можно отключить ИИ в конкретном диалоге или, наоборот,
            включить его в старых переписках, которые начались раньше.
          </p>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Enrolled dialogs */}
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <p className="font-medium">
              Под управлением ИИ{' '}
              <span className="text-sm font-normal text-muted-foreground">
                ({enrolled.length})
              </span>
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={refreshEnrolled}
              disabled={loadingEnrolled}
            >
              {loadingEnrolled ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Обновить
            </Button>
          </div>
          <Separator />
          {enrolled.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Пока ИИ не ведёт ни одного диалога. Новые диалоги появятся здесь
              автоматически, как только начнутся.
            </p>
          ) : (
            <div className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto">
              {enrolled.map((c) => (
                <div
                  key={c.conversationId}
                  className="flex items-start justify-between gap-2 rounded-md border border-border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{c.contactName}</span>
                      <Badge variant="secondary" className="shrink-0">
                        {channelLabel(c.channelType)}
                      </Badge>
                    </div>
                    <p className="line-clamp-1 text-sm text-muted-foreground">
                      {c.lastMessage}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-destructive hover:text-destructive"
                    disabled={busyId === c.conversationId}
                    onClick={() => unenroll(c.conversationId)}
                  >
                    {busyId === c.conversationId ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <X className="size-4" />
                    )}
                    Отключить
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Candidate dialogs */}
        <Card className="flex flex-col gap-3 p-4">
          <p className="font-medium">Включить ИИ в старом диалоге</p>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по имени контакта…"
              className="pl-8"
            />
          </div>
          <Separator />
          {loadingCandidates ? (
            <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Загрузка…
            </p>
          ) : available.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Нет доступных диалогов{search.trim() ? ' по этому запросу' : ''}.
            </p>
          ) : (
            <div className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto">
              {available.map((c) => (
                <div
                  key={c.conversationId}
                  className="flex items-start justify-between gap-2 rounded-md border border-border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{c.contactName}</span>
                      <Badge variant="secondary" className="shrink-0">
                        {channelLabel(c.channelType)}
                      </Badge>
                    </div>
                    <p className="line-clamp-1 text-sm text-muted-foreground">
                      {c.lastMessage}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    disabled={busyId === c.conversationId}
                    onClick={() => enroll(c.conversationId)}
                  >
                    {busyId === c.conversationId ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    Включить
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
