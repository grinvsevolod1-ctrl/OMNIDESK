'use client'

import { useState } from 'react'
import { KeyRound, Bot, Flame, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ApiKeysPanel } from './api-keys-panel'
import { BotPanel } from './bot-panel'
import { WarmupPanel } from './warmup-panel'
import { AccountsPanel } from './accounts-panel'

/**
 * Вкладка «Исходящие» god-панели: конфигурация отдельного Telegram API-контура
 * для исходящих касаний. Подвкладки:
 *   • API-ключи — пул api_id/api_hash (анти-бан);
 *   • Бот лидов — токен бота-приёмника + вебхук;
 *   • Аккаунты — пул боевых аккаунтов, здоровье, спам-блок, прогрев;
 *   • Прогрев — параметры прогрева и лимиты.
 *
 * Часть скрытой god-панели: экшены сами гейтятся requireGod().
 */
type SubTab = 'accounts' | 'keys' | 'bot' | 'warmup'

const SUBTABS: { id: SubTab; label: string; icon: typeof Users }[] = [
  { id: 'accounts', label: 'Аккаунты', icon: Users },
  { id: 'keys', label: 'API-ключи', icon: KeyRound },
  { id: 'bot', label: 'Бот лидов', icon: Bot },
  { id: 'warmup', label: 'Прогрев', icon: Flame },
]

export function SecretOutreachTab() {
  const [sub, setSub] = useState<SubTab>('accounts')

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-1.5 rounded-xl border border-border bg-card/40 p-1.5">
        {SUBTABS.map((t) => {
          const Icon = t.icon
          const active = t.id === sub
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setSub(t.id)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'press-scale flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <Icon className="size-4" />
              {t.label}
            </button>
          )
        })}
      </div>

      {sub === 'accounts' && <AccountsPanel />}
      {sub === 'keys' && <ApiKeysPanel />}
      {sub === 'bot' && <BotPanel />}
      {sub === 'warmup' && <WarmupPanel />}
    </div>
  )
}
