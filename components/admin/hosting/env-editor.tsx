'use client'

import { useState, useTransition } from 'react'
import { KeyRound, Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { updateAppEnvAction } from '@/app/actions/hosting'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

/**
 * Environment-variable editor. Values are encrypted at rest and NEVER sent back
 * to the browser, so the editor shows only the current KEYS and takes a full
 * KEY=VALUE block on save (whole-map replace). This keeps secrets off the wire
 * at the cost of re-entering values when editing — a deliberate security trade.
 */
export function EnvEditor({
  appId,
  envKeys,
}: {
  appId: string
  envKeys: string[]
}) {
  const [text, setText] = useState('')
  const [pending, startTransition] = useTransition()

  function save() {
    startTransition(async () => {
      const res = await updateAppEnvAction(appId, text)
      if (res.ok) {
        toast.success(res.message)
        setText('')
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="size-4" />
        Переменные окружения
      </div>

      {envKeys.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {envKeys.map((k) => (
            <span
              key={k}
              className="rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-xs text-muted-foreground"
            >
              {k}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Переменные ещё не заданы.
        </p>
      )}

      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'DATABASE_URL=postgres://…\nAPI_KEY=…\nPORT=3000'}
        className="h-40 font-mono text-xs"
        aria-label="Переменные окружения (KEY=VALUE)"
      />
      <p className="text-xs text-muted-foreground">
        Значения зашифрованы и не показываются. Вставьте полный набор
        переменных в формате KEY=VALUE — он заменит текущий и применится при
        следующем деплое.
      </p>

      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={pending || !text.trim()}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          Сохранить переменные
        </Button>
      </div>
    </div>
  )
}
