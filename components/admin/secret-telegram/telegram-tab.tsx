'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  personalListAccountsAction,
  type PersonalAccountItem,
} from '@/app/actions/admin-secret/telegram-personal'
import { AccountsList } from './accounts-list'
import { PersonalMessenger } from './personal-messenger'

/**
 * Вкладка «Telegram» god-панели: контейнер над AccountsList и
 * PersonalMessenger. Держит список личных аккаунтов (клиентская загрузка +
 * поллинг статусов, пока идёт авторизация) и выбранный аккаунт — открытый
 * аккаунт разворачивается в полноэкранный внутри-панельный мессенджер.
 *
 * Часть скрытой god-панели: экшены сами гейтятся requireGod(), никакого
 * упоминания этого модуля в обычной админке или Admin AI (AGENTS.md §4).
 */
export function SecretTelegramTab() {
  const [accounts, setAccounts] = useState<PersonalAccountItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [openAccount, setOpenAccount] = useState<PersonalAccountItem | null>(null)

  // Против гонок: поздний ответ старого refresh не должен перетереть новый.
  const seqRef = useRef(0)

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const seq = ++seqRef.current
    if (!opts?.silent) setRefreshing(true)
    try {
      const rows = await personalListAccountsAction()
      if (seqRef.current !== seq) return
      setAccounts(rows)
      // Если открытый аккаунт удалили/отключили в другом месте — закрываем чат.
      setOpenAccount((cur) => {
        if (!cur) return cur
        const fresh = rows.find((a) => a.id === cur.id)
        return fresh && fresh.sessionStatus === 'online' ? fresh : null
      })
    } catch {
      /* фоновая ошибка — оставляем то, что на экране; следующий тик доедет */
    } finally {
      if (seqRef.current === seq) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    // Первый рефреш через макротаск: setState синхронно внутри эффекта даёт
    // каскадный рендер (правило React Compiler) — а данные всё равно едут
    // по сети, один тик ничего не меняет.
    const kick = setTimeout(() => void refresh({ silent: true }), 0)
    // Поллинг статусов: авторизация (QR/код/2FA) меняет статус на воркере,
    // список должен подхватывать это без ручного «Обновить».
    const t = setInterval(() => {
      if (document.hidden) return
      void refresh({ silent: true })
    }, 8_000)
    return () => {
      clearTimeout(kick)
      clearInterval(t)
    }
  }, [refresh])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }

  if (openAccount) {
    return (
      <div className="h-[calc(100dvh-14rem)] min-h-[24rem] md:h-[calc(100dvh-11.5rem)]">
        <PersonalMessenger
          channelId={openAccount.id}
          accountName={openAccount.name}
          onBack={() => setOpenAccount(null)}
        />
      </div>
    )
  }

  return (
    <AccountsList
      accounts={accounts}
      onOpen={(a) => setOpenAccount(a)}
      onRefresh={() => void refresh()}
      refreshing={refreshing}
    />
  )
}
