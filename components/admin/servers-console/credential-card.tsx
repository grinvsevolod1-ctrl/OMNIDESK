'use client'

import { useState } from 'react'
import { Check, KeyRound, Loader2, ServerCog } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  saveRepoTokenAction,
  saveServerCredentialsAction,
} from '@/app/actions/hosting-console'
import type { CredentialRequest } from '@/lib/servers-console/assistant'
import type { ServerAuthType } from '@/lib/types'

/* ------------------------- Secure credential card ----------------------- */

/**
 * The one place the admin enters a secret (SSH key/password or GitHub token).
 * It submits straight to a server action — the value NEVER passes through the
 * LLM or the chat transcript.
 */
export function CredentialCard({
  request,
  onSaved,
}: {
  request: CredentialRequest
  onSaved: () => void
}) {
  const [done, setDone] = useState(false)
  if (request.kind === 'repo_token') {
    return (
      <RepoTokenForm request={request} done={done} setDone={setDone} onSaved={onSaved} />
    )
  }
  return (
    <ServerCredentialForm
      request={request}
      done={done}
      setDone={setDone}
      onSaved={onSaved}
    />
  )
}

function ServerCredentialForm({
  request,
  done,
  setDone,
  onSaved,
}: {
  request: CredentialRequest
  done: boolean
  setDone: (v: boolean) => void
  onSaved: () => void
}) {
  const [authType, setAuthType] = useState<ServerAuthType>(
    request.authType ?? 'ssh_key',
  )
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setBusy(true)
    try {
      const fd = new FormData(e.currentTarget)
      fd.set('authType', authType)
      const res = await saveServerCredentialsAction(fd)
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      setDone(true)
      onSaved()
    } catch {
      toast.error('Не удалось сохранить сервер.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <SavedNote text="Сервер подключён. Теперь можно сказать: «разверни репозиторий …»." />
    )
  }

  return (
    <Card className="ml-9 flex flex-col gap-3 border-primary/20 p-4 duration-300 animate-in fade-in slide-in-from-top-1">
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-primary/10 p-1.5 text-primary">
          <KeyRound className="size-4" />
        </span>
        <div>
          <p className="text-sm font-medium">Подключение сервера</p>
          <p className="text-xs text-muted-foreground">
            {request.note ?? 'Секрет вводится напрямую и не проходит через ИИ.'}
          </p>
        </div>
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Название">
            <Input name="name" defaultValue={request.name ?? ''} required placeholder="Прод-сервер" />
          </Field>
          <Field label="IP-адрес или хост">
            <Input
              name="ipAddress"
              defaultValue={request.ipAddress ?? ''}
              required
              placeholder="203.0.113.10"
            />
          </Field>
          <Field label="SSH-порт">
            <Input
              name="sshPort"
              type="number"
              defaultValue={String(request.sshPort ?? 22)}
              min={1}
              max={65535}
            />
          </Field>
          <Field label="Пользователь">
            <Input
              name="sshUsername"
              defaultValue={request.sshUsername ?? 'root'}
              placeholder="root"
            />
          </Field>
          <Field label="Способ входа">
            <Select
              value={authType}
              onValueChange={(v) => setAuthType(v as ServerAuthType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ssh_key">SSH-ключ</SelectItem>
                <SelectItem value="password">Пароль</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field
          label={authType === 'ssh_key' ? 'Приватный SSH-ключ' : 'Пароль SSH'}
        >
          {authType === 'ssh_key' ? (
            <Textarea
              name="secret"
              required
              rows={4}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              className="resize-none font-mono text-xs"
              autoComplete="off"
            />
          ) : (
            <Input
              name="secret"
              type="password"
              required
              placeholder="••••••••"
              autoComplete="off"
            />
          )}
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={busy} className="gap-1.5">
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ServerCog className="size-4" />
            )}
            Подключить сервер
          </Button>
        </div>
      </form>
    </Card>
  )
}

function RepoTokenForm({
  request,
  done,
  setDone,
  onSaved,
}: {
  request: CredentialRequest
  done: boolean
  setDone: (v: boolean) => void
  onSaved: () => void
}) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!request.appId) {
      toast.error('Не указано приложение для токена.')
      return
    }
    setBusy(true)
    try {
      const res = await saveRepoTokenAction(request.appId, token)
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      setDone(true)
      onSaved()
    } catch {
      toast.error('Не удалось сохранить токен.')
    } finally {
      setBusy(false)
    }
  }

  if (done) return <SavedNote text="Токен сохранён. Можно запускать установку." />

  return (
    <Card className="ml-9 flex flex-col gap-3 border-primary/20 p-4 duration-300 animate-in fade-in slide-in-from-top-1">
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-primary/10 p-1.5 text-primary">
          <KeyRound className="size-4" />
        </span>
        <div>
          <p className="text-sm font-medium">Токен приватного репозитория</p>
          <p className="text-xs text-muted-foreground">
            {request.note ?? 'Токен вводится напрямую и не проходит через ИИ.'}
          </p>
        </div>
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field label="GitHub-токен">
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            placeholder="ghp_…"
            autoComplete="off"
          />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={busy || !token.trim()} className="gap-1.5">
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <KeyRound className="size-4" />
            )}
            Сохранить токен
          </Button>
        </div>
      </form>
    </Card>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

function SavedNote({ text }: { text: string }) {
  return (
    <div className="ml-9 flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/5 px-3.5 py-2.5 text-sm text-emerald-600 duration-300 animate-in fade-in dark:text-emerald-400">
      <Check className="size-4 shrink-0" />
      {text}
    </div>
  )
}
