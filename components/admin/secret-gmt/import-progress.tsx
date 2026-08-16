'use client'

/**
 * Диалог прогресса автоимпорта купленного номера в god-аккаунт (вкладка
 * «Telegram»). Оркестрацией дирижирует клиент (use-auto-import). Вынесено из
 * secret-gmt-tab.tsx. Часть god-панели — инварианты AGENTS.md §4.
 */

import { CheckCircle2, Loader2, TriangleAlert, UserPlus } from 'lucide-react'
import { type ImportState } from '@/components/admin/secret-gmt/use-auto-import'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const IMPORT_STEPS: { phase: ImportState['phase']; label: string }[] = [
  { phase: 'creating', label: 'Создание god-аккаунта' },
  { phase: 'requesting_code', label: 'Запрос кода у Get My TG' },
  { phase: 'waiting_code', label: 'Ожидание SMS-кода' },
  { phase: 'submitting_code', label: 'Ввод кода' },
  { phase: 'submitting_password', label: 'Ввод пароля 2FA' },
  { phase: 'finalizing', label: 'Подключение к Telegram' },
]

/**
 * Живой прогресс автоимпорта: какая фаза идёт, какие пройдены. Открыт, пока
 * оркестратор работает; при успехе/ошибке остаётся до явного закрытия, чтобы
 * итог не мелькнул незамеченным.
 */
export function ImportProgressDialog({
  state,
  onClose,
}: {
  state: ImportState
  onClose: () => void
}) {
  const open = state.phase !== 'idle'
  const finished = state.phase === 'done' || state.phase === 'error'
  const activeIdx = IMPORT_STEPS.findIndex((s) => s.phase === state.phase)

  return (
    <Dialog open={open} onOpenChange={(v) => !v && finished && onClose()}>
      <DialogContent className="sm:max-w-sm" showCloseButton={finished}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="size-4 text-primary" aria-hidden />
            Импорт в god-аккаунты
          </DialogTitle>
          <DialogDescription>
            {state.phone ? (
              <span className="font-mono">{state.phone}</span>
            ) : (
              'Автоматическое подключение купленного номера'
            )}
          </DialogDescription>
        </DialogHeader>

        {state.phase === 'done' ? (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <CheckCircle2 className="size-10 text-success" aria-hidden />
            <p className="text-sm font-medium">Аккаунт подключён</p>
            <p className="text-xs text-muted-foreground">
              Номер уже во вкладке «Telegram» — переписка доступна сразу.
            </p>
          </div>
        ) : state.phase === 'error' ? (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <TriangleAlert className="size-10 text-destructive" aria-hidden />
            <p className="text-sm font-medium">Импорт не завершён</p>
            <p className="text-xs text-muted-foreground">{state.error}</p>
            <p className="text-xs text-muted-foreground">
              Покупка не потеряна: откройте её в «Покупках» и нажмите
              «Импортировать» ещё раз.
            </p>
          </div>
        ) : (
          <ol className="flex flex-col gap-2 py-2">
            {IMPORT_STEPS.map((step, i) => {
              const isActive = i === activeIdx
              const isDone = activeIdx > i
              return (
                <li
                  key={step.phase}
                  className="flex items-center gap-2.5 text-sm"
                >
                  {isDone ? (
                    <CheckCircle2
                      className="size-4 shrink-0 text-success"
                      aria-hidden
                    />
                  ) : isActive ? (
                    <Loader2
                      className="size-4 shrink-0 animate-spin text-primary"
                      aria-hidden
                    />
                  ) : (
                    <span
                      className="size-4 shrink-0 rounded-full border border-border"
                      aria-hidden
                    />
                  )}
                  <span
                    className={
                      isActive
                        ? 'font-medium'
                        : isDone
                          ? 'text-muted-foreground'
                          : 'text-muted-foreground/60'
                    }
                  >
                    {step.label}
                  </span>
                  {isActive && state.detail ? (
                    <span className="text-xs text-muted-foreground">
                      {state.detail}
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  )
}
