'use client'

/**
 * ОБЯЗАТЕЛЬНЫЙ гейт «Telegram для кандидатов» (миграция 146).
 *
 * Куратор не может пользоваться панелью, пока не укажет свой Telegram: без
 * него менеджер физически не сможет передать кандидату контакт при передаче
 * лида. Поэтому layout куратора (`app/curator/layout.tsx`) при пустом
 * `telegram_contact` рендерит ТОЛЬКО этот экран — без навигации и без доступа
 * к остальным разделам. После успешного сохранения делаем `router.refresh()`,
 * layout перечитывает строку из БД и пускает в панель.
 *
 * Валидацию/нормализацию (@username или t.me/username → «@username») делает тот
 * же серверный экшн `updateMyTelegramContactAction`, что и в настройках.
 */
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Send } from 'lucide-react'
import { toast } from 'sonner'
import { updateMyTelegramContactAction } from '@/app/actions/managers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function TelegramContactGate({ curatorName }: { curatorName: string }) {
  const router = useRouter()
  const [value, setValue] = useState('')
  const [pending, startTransition] = useTransition()

  const canSave = value.trim().length > 0 && !pending

  function save() {
    if (!canSave) return
    startTransition(async () => {
      const res = await updateMyTelegramContactAction(value)
      if (res.ok) {
        toast.success(res.message)
        // Layout — серверный: перечитает telegram_contact и пустит в панель.
        router.refresh()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <div className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Send className="size-5" />
        </div>
        <h1 className="mt-4 text-lg font-semibold text-balance">
          Укажите Telegram для кандидатов
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground text-pretty">
          {curatorName ? `${curatorName}, чтобы` : 'Чтобы'} продолжить работу в
          панели, укажите ваш актуальный Telegram. Этот контакт менеджер
          отправляет кандидату при передаче лида — кандидат напишет вам сам. Без
          него принимать лиды нельзя.
        </p>

        <form
          className="mt-6 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <Label htmlFor="gate-telegram-contact" className="sr-only">
            Telegram для кандидатов
          </Label>
          <Input
            id="gate-telegram-contact"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="@username или t.me/username"
            autoComplete="off"
            autoFocus
            disabled={pending}
          />
          <Button type="submit" disabled={!canSave} className="mt-2">
            {pending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Сохраняем…
              </>
            ) : (
              'Сохранить и продолжить'
            )}
          </Button>
        </form>

        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Позже контакт можно изменить в разделе «Настройки» — например, если
          Telegram-аккаунт слетел или заменён.
        </p>
      </div>
    </main>
  )
}
