'use client'

import type { Dispatch, SetStateAction } from 'react'
import { Loader2, Plus, Wallet } from 'lucide-react'
import { nf } from '@/components/admin/secret-sites/site-editor-helpers'
import type { SiteState } from '@/lib/god-sites'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Cabinet header of the vitrine: login, balance, currency, an instant top-up
 * (server-side atomic increment) and the organization card fields.
 */
export function SiteCabinetCard({
  state,
  setState,
  autoEnabled,
  vitrineBalance,
  topUpAmount,
  setTopUpAmount,
  onTopUp,
  pending,
}: {
  state: SiteState
  setState: Dispatch<SetStateAction<SiteState>>
  autoEnabled: boolean
  vitrineBalance: number
  topUpAmount: string
  setTopUpAmount: (v: string) => void
  onTopUp: () => void
  pending: boolean
}) {
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <Wallet className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Кабинет</h2>
        <span className="text-xs text-muted-foreground">
          — шапка витрины: логин, баланс, валюта и данные организации
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="site-login">Логин кабинета</Label>
          <Input
            id="site-login"
            value={state.login}
            placeholder="client-login"
            onChange={(e) => setState((s) => ({ ...s, login: e.target.value }))}
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="site-balance">Баланс (задать точно)</Label>
          <Input
            id="site-balance"
            type="number"
            min={0}
            step="0.01"
            value={state.balance}
            onChange={(e) =>
              setState((s) => ({ ...s, balance: Number(e.target.value) || 0 }))
            }
            className="font-mono"
          />
          {autoEnabled && (
            <p className="text-xs text-muted-foreground">
              Сейчас на витрине ≈{' '}
              <span className="font-mono font-medium text-foreground">
                {nf.format(vitrineBalance)} {state.currency}
              </span>{' '}
              — с учётом скрутки за сегодня.{' '}
              <span className="text-warning">
                При включённой авто-скрутке точное значение может разойтись с
                параллельным списанием — надёжнее «Пополнить» ниже.
              </span>
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="site-currency">Валюта</Label>
          <Input
            id="site-currency"
            value={state.currency}
            placeholder="₽"
            onChange={(e) => setState((s) => ({ ...s, currency: e.target.value }))}
          />
        </div>
      </div>
      {/* Top-up: adds to the CURRENT balance server-side (atomic increment,
          applied instantly — no "Сохранить всё" needed). The plain input
          above stays for setting an exact value. */}
      <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
        <Label htmlFor="site-topup">Пополнить баланс</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="site-topup"
            type="number"
            min={0}
            step="0.01"
            value={topUpAmount}
            placeholder={`Сумма, ${state.currency}`}
            onChange={(e) => setTopUpAmount(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault()
                onTopUp()
              }
            }}
            className="max-w-40 font-mono"
          />
          <Button
            size="sm"
            onClick={onTopUp}
            // `!(x > 0)` — NaN от мусорного ввода тоже дизейблит кнопку,
            // тогда как `x <= 0` для NaN даёт false и кнопка «врала».
            disabled={pending || !(Number(topUpAmount.replace(',', '.')) > 0)}
            className="press-scale gap-1.5"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Пополнить
          </Button>
          <span className="text-xs text-muted-foreground">
            прибавится к текущему балансу и применится сразу
          </span>
        </div>
      </div>

      {/* Organization card — окно по клику на аватар на витрине. Пустые
          поля не отправляются, страница показывает свой прочерк. */}
      <div className="grid grid-cols-1 gap-3 border-t pt-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="site-org">Организация</Label>
          <Input
            id="site-org"
            value={state.organization}
            placeholder="ООО Ромашка"
            onChange={(e) =>
              setState((s) => ({ ...s, organization: e.target.value }))
            }
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="site-phone">Телефон</Label>
          <Input
            id="site-phone"
            value={state.phone}
            placeholder="+7 900 123-45-67"
            onChange={(e) => setState((s) => ({ ...s, phone: e.target.value }))}
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="site-orgid">Идентификатор</Label>
          <Input
            id="site-orgid"
            value={state.orgId}
            placeholder={state.login || 'porg-xxxxxx'}
            onChange={(e) => setState((s) => ({ ...s, orgId: e.target.value }))}
            className="font-mono"
          />
        </div>
      </div>
    </Card>
  )
}
