'use client'

/**
 * Модалка «Выгрузить диалог»: одна галочка «Вложить медиафайлы» (по умолчанию
 * включена), прогресс докачки и кнопка скачивания. Общая для куратора
 * (/curator/chats) и руководителя (/head/chats) — право доступа решает
 * серверный экшен `exportDialogAction`, а медиа качается через тот же
 * `/api/media/{id}`, что и лента. Логика упаковки — lib/dialog-export/client.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { Download, FileArchive, FileText, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { exportDialogAction } from '@/app/actions/dialog-export'
import {
  runDialogExport,
  type DialogExportOutcome,
  type ExportPhase,
} from '@/lib/dialog-export/client'
import type { Conversation } from '@/lib/types'

export function DialogExportDialog({
  conversation,
  open,
  onOpenChange,
}: {
  conversation: Conversation
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Состояние живёт во внутреннем компоненте: он размонтируется вместе
            с попапом, так что каждое открытие начинается с чистого листа, а
            незавершённая докачка отменяется в cleanup. */}
        <ExportBody
          conversation={conversation}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function ExportBody({
  conversation,
  onClose,
}: {
  conversation: Conversation
  onClose: () => void
}) {
  const [includeMedia, setIncludeMedia] = useState(true)
  const [phase, setPhase] = useState<ExportPhase | null>(null)
  const [done, setDone] = useState<DialogExportOutcome | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const checkboxId = useId()

  // Закрытие модалки (крестик/фон) во время докачки отменяет её — иначе
  // fetch'и медиа продолжали бы крутиться в фоне без прогресса на экране.
  useEffect(() => () => abortRef.current?.abort(), [])

  const busy = phase !== null

  const start = async () => {
    const controller = new AbortController()
    abortRef.current = controller
    setDone(null)
    try {
      const outcome = await runDialogExport({
        fetchPayload: () => exportDialogAction(conversation.id),
        includeMedia,
        onPhase: setPhase,
        signal: controller.signal,
      })
      setDone(outcome)
      toast.success(`Файл ${outcome.filename} сохранён`)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Не удалось выгрузить диалог'
      toast.error(message)
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      if (!controller.signal.aborted) setPhase(null)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Выгрузить диалог</DialogTitle>
        <DialogDescription>
          Вся переписка с {conversation.contactName} в одном файле: порядок
          сообщений, дата, время (МСК) и отправитель. Открывается в любом
          браузере.
        </DialogDescription>
      </DialogHeader>

      <label
        htmlFor={checkboxId}
        className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-muted/30 p-3"
      >
        <input
          id={checkboxId}
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-primary"
          checked={includeMedia}
          disabled={busy}
          onChange={(e) => setIncludeMedia(e.target.checked)}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">Вложить медиафайлы</span>
          <span className="text-xs text-muted-foreground">
            Фото, документы, голосовые и видео попадут в архив рядом с
            перепиской. Без галочки будет один HTML-файл без вложений.
          </span>
        </span>
      </label>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {includeMedia ? (
          <FileArchive className="size-4 shrink-0" />
        ) : (
          <FileText className="size-4 shrink-0" />
        )}
        <span>
          Формат:{' '}
          {includeMedia ? 'ZIP-архив (dialog.html + папка media)' : 'HTML-файл'}
        </span>
      </div>

      {phase ? <ExportProgress phase={phase} /> : null}
      {done && !phase ? <ExportSummary outcome={done} /> : null}

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {done ? 'Закрыть' : 'Отмена'}
        </Button>
        <Button onClick={start} disabled={busy}>
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          {done ? 'Скачать ещё раз' : 'Скачать'}
        </Button>
      </DialogFooter>
    </>
  )
}

function ExportProgress({ phase }: { phase: ExportPhase }) {
  const label =
    phase.step === 'loading'
      ? 'Собираем историю переписки…'
      : phase.step === 'media'
        ? `Скачиваем вложения: ${phase.done} из ${phase.total}`
        : 'Формируем файл…'
  const ratio =
    phase.step === 'media' && phase.total > 0 ? phase.done / phase.total : null
  return (
    <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={
            ratio === null
              ? 'h-full w-1/3 animate-pulse rounded-full bg-primary/70'
              : 'h-full rounded-full bg-primary transition-[width]'
          }
          style={ratio === null ? undefined : { width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
    </div>
  )
}

function ExportSummary({ outcome }: { outcome: DialogExportOutcome }) {
  const mediaNote =
    outcome.mediaTotal === 0
      ? 'вложений в переписке нет'
      : outcome.mediaAttached === 0
        ? `вложения (${outcome.mediaTotal}) не включены`
        : outcome.mediaAttached === outcome.mediaTotal
          ? `вложений: ${outcome.mediaAttached}`
          : `вложений: ${outcome.mediaAttached} из ${outcome.mediaTotal} (остальные не удалось скачать)`
  return (
    <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      Готово: {outcome.filename} — сообщений: {outcome.messages}, {mediaNote}
      {outcome.truncated ? '. История длиннее лимита: выгружены самые свежие.' : '.'}
    </p>
  )
}
