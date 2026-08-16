'use client'

/** Отключение 2FA с подтверждением текущим паролем (destructive-стиль). */
import { Loader2, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

export function TwofaDisableCard({
  pending,
  onDisable,
}: {
  pending: boolean
  onDisable: (formData: FormData) => void
}) {
  return (
    <Card className="border-destructive/30 p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-destructive/30 bg-destructive/10 text-destructive">
          <Lock className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">Отключить защиту</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Второй фактор и резервные коды будут удалены. Подтвердите действие
            текущим паролем.
          </p>
          <form action={onDisable} className="mt-3 flex max-w-sm gap-2">
            <Input
              id="twofa-disable-password"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Текущий пароль"
              required
              aria-label="Текущий пароль"
            />
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                'Отключить'
              )}
            </Button>
          </form>
        </div>
      </div>
    </Card>
  )
}
