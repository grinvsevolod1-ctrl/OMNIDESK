'use client'

/**
 * God-панель, вкладка «API TG» — покупка Telegram-аккаунтов через Get My TG
 * (docs.getmytg.com). Часть скрытой панели: подчиняется инвариантам AGENTS.md
 * §4 (обычная админка и Admin AI о вкладке не знают).
 *
 * Этот файл — только оркестратор: шапка профиля, переключатель секций и
 * автоимпорт. Реальные секции вынесены в ./secret-gmt/*:
 *   - profile-header — шапка профиля + управление ключом API
 *   - catalog        — Каталог (страны, скидка, покупка 1 шт / опт)
 *   - purchases      — Покупки (статусы, креды, возврат, пагинация)
 *   - bulk           — Опт (архивы bulk-закупок)
 *   - import-progress — диалог прогресса автоимпорта в god-аккаунт
 *   - shared         — форматтеры, бейджи статусов, память bulk-ID
 *
 * Данные — точечный SWR по server actions; в БД панели хранится ТОЛЬКО ключ
 * API (god_settings, миграция 139 — назначается из этой вкладки, env
 * GMT_API_KEY остаётся fallback'ом), остальное читается из API напрямую;
 * ID bulk-закупок панель помнит в localStorage браузера (у API нет списка).
 */

import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { Boxes, Package, ShoppingCart } from 'lucide-react'
import {
  secretGmtImportedPhonesAction,
  secretGmtProfileAction,
  secretGmtStatusAction,
} from '@/app/actions/admin-secret'
import { useAutoImport } from '@/components/admin/secret-gmt/use-auto-import'
import {
  GmtKeySetupCard,
  ProfileHeader,
} from '@/components/admin/secret-gmt/profile-header'
import { CatalogSection } from '@/components/admin/secret-gmt/catalog'
import { PurchasesSection } from '@/components/admin/secret-gmt/purchases'
import { BulkSection } from '@/components/admin/secret-gmt/bulk'
import { ImportProgressDialog } from '@/components/admin/secret-gmt/import-progress'
import { cn } from '@/lib/utils'

type Section = 'catalog' | 'purchases' | 'bulk'

export function SecretGmtTab() {
  const [section, setSection] = useState<Section>('catalog')

  const { data: status, mutate: mutateStatus } = useSWR('gmt-status', async () => {
    const res = await secretGmtStatusAction()
    return res.data ?? null
  })

  const configured = status?.configured ?? true

  const { data: profile, mutate: mutateProfile } = useSWR(
    configured ? 'gmt-profile' : null,
    async () => {
      const res = await secretGmtProfileAction()
      if (!res.ok) throw new Error(res.message)
      return res.data ?? null
    },
    { revalidateOnFocus: false },
  )

  // Номера, уже заведённые как god-аккаунты — для бейджей «в god-аккаунтах».
  const { data: importedPhones, mutate: mutateImported } = useSWR(
    configured ? 'gmt-imported-phones' : null,
    () => secretGmtImportedPhonesAction(),
    { revalidateOnFocus: false },
  )
  const importedSet = useMemo(
    () => new Set(importedPhones ?? []),
    [importedPhones],
  )

  // Оркестратор автоимпорта живёт в корне вкладки: прогресс переживает
  // переключение секций «Каталог» ↔ «Покупки».
  const autoImport = useAutoImport(() => {
    void mutateImported()
  })

  if (status && !status.configured) {
    return <GmtKeySetupCard onSaved={() => void mutateStatus()} />
  }

  return (
    <div className="flex flex-col gap-4">
      <ProfileHeader
        profile={profile ?? null}
        health={status?.health ?? 'unreachable'}
        keySource={status?.keySource ?? null}
        keyMasked={status?.keyMasked ?? null}
        onRefresh={() => void mutateProfile()}
        onKeyChanged={() => {
          void mutateStatus()
          void mutateProfile()
        }}
      />

      {/* Переключатель секций */}
      <div className="flex w-fit items-center gap-1 rounded-lg border border-border bg-muted/30 p-1">
        {(
          [
            { id: 'catalog', label: 'Каталог', icon: ShoppingCart },
            { id: 'purchases', label: 'Покупки', icon: Package },
            { id: 'bulk', label: 'Опт', icon: Boxes },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSection(t.id)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
              section === t.id
                ? 'bg-background font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <t.icon className="size-3.5" aria-hidden />
            {t.label}
          </button>
        ))}
      </div>

      {section === 'catalog' ? (
        <CatalogSection
          balance={profile?.balance ?? null}
          onPurchased={(purchase) => {
            void mutateProfile()
            setSection('purchases')
            // Автоимпорт: сразу дожимаем купленный номер до god-аккаунта.
            if (purchase?.id) void autoImport.run(purchase.id)
          }}
          onBulkCreated={() => {
            void mutateProfile()
            setSection('bulk')
          }}
        />
      ) : null}
      {section === 'purchases' ? (
        <PurchasesSection
          onBalanceChanged={() => void mutateProfile()}
          importedSet={importedSet}
          onImport={(id) => void autoImport.run(id)}
          importState={autoImport.state}
        />
      ) : null}
      {section === 'bulk' ? <BulkSection /> : null}

      <ImportProgressDialog state={autoImport.state} onClose={autoImport.reset} />
    </div>
  )
}
