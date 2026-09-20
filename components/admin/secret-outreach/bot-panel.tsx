'use client'

import { useEffect, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Loader2, Bot, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  clearBotTokenAction,
  getBotConfigAction,
  setBotTokenAction,
} from '@/app/actions/admin-secret/outreach-config'
import type { OutreachBotConfig } from '@/lib/data/outreach-config'

/**
 * Бот-приёмник лидов: владелец пересылает боту сообщения из сторонней группы,
 * вебхук создаёт лид и раздаёт менеджерам. Здесь настраивается токен и username.
 */
export function BotPanel() {
  const [cfg, setCfg] = useState<OutreachBotConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, startTransition] = useTransition()
  const [token, setToken] = useState('')
  const [username, setUsername] = useState('')

  useEffect(() => {
    let cancelled = false
    getBotConfigAction()
      .then((c) => {
        if (!cancelled) {
          setCfg(c)
          setUsername(c.username)
        }
      })
      .catch(() => toast.error('Не удалось загрузить настройки бота'))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  function save() {
    if (!token.trim()) {
      toast.error('Вставьте токен бота из @BotFather')
      return
    }
    startTransition(async () => {
      try {
        const next = await setBotTokenAction({
          token: token.trim(),
          username: username.trim(),
        })
        setCfg(next)
        setToken('')
        toast.success('Токен сохранён')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Ошибка')
      }
    })
  }

  function clear() {
    startTransition(async () => {
      try {
        const next = await clearBotTokenAction()
        setCfg(next)
        setToken('')
        toast.success('Токен удалён')
      } catch {
        toast.error('Ошибка')
      }
    })
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-card/40 p-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-muted/40">
            <Bot className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Статус бота</p>
            <p className="text-xs text-muted-foreground">
              {cfg?.username ? `@${cfg.username}` : 'username не задан'}
            </p>
          </div>
          <Badge variant={cfg?.hasToken ? 'default' : 'secondary'} className="gap-1">
            {cfg?.hasToken ? (
              <>
                <Check className="size-3" /> подключён
              </>
            ) : (
              <>
                <X className="size-3" /> не настроен
              </>
            )}
          </Badge>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card/40 p-4 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="bot-username">Username бота (без @)</Label>
          <Input
            id="bot-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="my_leads_bot"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bot-token">Токен бота (@BotFather)</Label>
          <Input
            id="bot-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={cfg?.hasToken ? '•••••• (заменить)' : '123456:ABC-DEF…'}
            autoComplete="off"
            type="password"
          />
          <p className="text-xs text-muted-foreground text-pretty">
            Токен хранится в зашифрованном виде. После сохранения вебхук
            привязывается автоматически.
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {cfg?.hasToken && (
            <Button variant="outline" onClick={clear} disabled={pending}>
              Удалить токен
            </Button>
          )}
          <Button onClick={save} disabled={pending} className="gap-1.5">
            {pending && <Loader2 className="size-4 animate-spin" />}
            Сохранить
          </Button>
        </div>
      </div>
    </div>
  )
}
