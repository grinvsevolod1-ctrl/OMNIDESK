'use client'

/**
 * God-панель, вкладка «Ping» — проверка доступности своего домена/URL.
 *
 * Владелец вводит адрес, панель делает несколько HTTP-запросов и показывает
 * статус-код и задержку каждой попытки + сводку (min/avg/max, потери).
 * Часть скрытой панели: подчиняется инвариантам AGENTS.md §4 (обычная
 * админка и Admin AI о вкладке не знают, сервер-экшен не пишет в audit).
 *
 * Это простой uptime-чекер: читаются только статус-код и время ответа.
 */

import { useState } from 'react'
import { toast } from 'sonner'
import {
  Activity,
  ArrowRight,
  Boxes,
  CircleAlert,
  CircleCheck,
  Copy,
  Database,
  Gauge,
  Loader2,
  Lock,
  LockOpen,
  Radio,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import {
  secretPingAction,
  secretS3ScanAction,
  secretSecurityAssessAction,
  secretSecurityAuditAction,
  type PingResult,
  type S3ScanResult,
  type SecurityAudit,
} from '@/app/actions/admin-secret'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Markdown } from '@/components/admin/secret-markdown'
import { cn } from '@/lib/utils'

const ATTEMPT_OPTIONS = [1, 2, 4, 6]

export function SecretPingTab() {
  const [url, setUrl] = useState('')
  const [attempts, setAttempts] = useState(4)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<PingResult | null>(null)

  const [auditPending, setAuditPending] = useState(false)
  const [audit, setAudit] = useState<SecurityAudit | null>(null)
  const [assessPending, setAssessPending] = useState(false)
  const [assessment, setAssessment] = useState<string | null>(null)

  const [bucket, setBucket] = useState('')
  const [s3Pending, setS3Pending] = useState(false)
  const [s3Result, setS3Result] = useState<S3ScanResult | null>(null)

  async function runPing() {
    const target = url.trim()
    if (!target) {
      toast.error('Введите домен или URL')
      return
    }
    setPending(true)
    setResult(null)
    try {
      const res = await secretPingAction(target, attempts)
      if (res.ok && res.data) {
        setResult(res.data)
        if (res.data.received === 0) toast.error(res.message)
      } else {
        toast.error(res.message)
      }
    } catch {
      toast.error('Внутренняя ошибка при проверке')
    } finally {
      setPending(false)
    }
  }

  async function runAudit() {
    const target = url.trim()
    if (!target) {
      toast.error('Введите домен или URL')
      return
    }
    setAuditPending(true)
    setAudit(null)
    setAssessment(null)
    try {
      const res = await secretSecurityAuditAction(target)
      if (res.ok && res.data) {
        setAudit(res.data)
      } else {
        if (res.data) setAudit(res.data)
        toast.error(res.message)
      }
    } catch {
      toast.error('Внутренняя ошибка при аудите')
    } finally {
      setAuditPending(false)
    }
  }

  async function runAssess() {
    const target = url.trim()
    if (!target) {
      toast.error('Введите домен или URL')
      return
    }
    setAssessPending(true)
    setAssessment(null)
    try {
      const res = await secretSecurityAssessAction(target)
      if (res.audit) setAudit(res.audit)
      if (res.ok && res.report) {
        setAssessment(res.report)
      } else {
        toast.error(res.message)
      }
    } catch {
      toast.error('Внутренняя ошибка при формировании заключения')
    } finally {
      setAssessPending(false)
    }
  }

  async function runS3Scan() {
    const target = bucket.trim()
    if (!target) {
      toast.error('Введите имя S3-бакета или URL')
      return
    }
    setS3Pending(true)
    setS3Result(null)
    try {
      const res = await secretS3ScanAction(target)
      if (res.ok && res.data) {
        setS3Result(res.data)
        if (res.data.verdict === 'public') toast.error(res.message)
      } else {
        toast.error(res.message)
      }
    } catch {
      toast.error('Внутренняя ошибка при сканировании')
    } finally {
      setS3Pending(false)
    }
  }

  async function copyAssessment() {
    if (!assessment) return
    try {
      await navigator.clipboard.writeText(assessment)
      toast.success('Заключение скопировано')
    } catch {
      toast.error('Не удалось скопировать')
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* ---- Ввод адреса ---- */}
      <div className="rounded-xl border border-border bg-card/40 p-4 md:p-5">
        <div className="mb-4 flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Radio className="size-4" />
          Проверка доступности
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Activity className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.nativeEvent.isComposing &&
                  e.keyCode !== 229 &&
                  !pending
                ) {
                  void runPing()
                }
              }}
              placeholder="example.com или https://example.com/health"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="pl-9 font-mono text-sm"
              aria-label="Домен или URL для проверки"
            />
          </div>

          <Button
            onClick={() => void runPing()}
            disabled={pending}
            className="press-scale gap-1.5"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowRight className="size-4" />
            )}
            Проверить
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Попыток:</span>
          {ATTEMPT_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setAttempts(n)}
              className={cn(
                'press-scale rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                attempts === n
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              {n}
            </button>
          ))}

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runAudit()}
              disabled={auditPending}
              className="press-scale gap-1.5"
            >
              {auditPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="size-3.5" />
              )}
              Аудит безопасности
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runAssess()}
              disabled={assessPending}
              className="press-scale gap-1.5"
            >
              {assessPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              AI-заключение
            </Button>
          </div>
        </div>
      </div>

      {/* ---- Сканирование S3-бакета ---- */}
      <div className="rounded-xl border border-border bg-card/40 p-4 md:p-5">
        <div className="mb-4 flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Boxes className="size-4" />
          Сканирование S3-бакета
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Database className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.nativeEvent.isComposing &&
                  e.keyCode !== 229 &&
                  !s3Pending
                ) {
                  void runS3Scan()
                }
              }}
              placeholder="my-bucket или my-bucket.s3.amazonaws.com"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="pl-9 font-mono text-sm"
              aria-label="Имя S3-бакета или URL"
            />
          </div>

          <Button
            onClick={() => void runS3Scan()}
            disabled={s3Pending}
            className="press-scale gap-1.5"
          >
            {s3Pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowRight className="size-4" />
            )}
            Сканировать
          </Button>
        </div>

        <p className="mt-3 text-xs text-muted-foreground text-pretty">
          Пассивная проверка: только читает публичный ответ S3, чтобы понять,
          открыт ли листинг наружу. Ничего не пишет и не удаляет.
        </p>
      </div>

      {/* ---- Результат сканирования S3 ---- */}
      {s3Result && <S3Report result={s3Result} />}

      {/* ---- Результат ping ---- */}
      {result && <PingReport result={result} />}

      {/* ---- Аудит безопасности ---- */}
      {audit && <AuditReport audit={audit} />}

      {/* ---- AI-заключение ---- */}
      {(assessment || assessPending) && (
        <div className="rounded-xl border border-border bg-card/40 p-4 md:p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Sparkles className="size-4" />
            Заключение по защищённости
            {assessment && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void copyAssessment()}
                className="ml-auto size-7"
                aria-label="Скопировать заключение"
              >
                <Copy className="size-3.5" />
              </Button>
            )}
          </div>
          {assessPending ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Анализирую конфигурацию…
            </div>
          ) : (
            assessment && <Markdown text={assessment} />
          )}
        </div>
      )}

      {!result && !audit && !pending && !auditPending && !assessPending && (
        <p className="px-1 text-sm text-muted-foreground text-pretty">
          Введите свой домен или адрес страницы состояния. «Проверить» измерит
          HTTP-статус и задержку, «Аудит безопасности» соберёт заголовки защиты
          и флаги cookie, а «AI-заключение» даст рекомендации по харденингу.
        </p>
      )}
    </div>
  )
}

/* ------------------------------ Аудит UI -------------------------------- */

/** Человекочитаемые подписи проверяемых заголовков. */
const HEADER_LABELS: Record<string, string> = {
  'strict-transport-security': 'HSTS',
  'content-security-policy': 'CSP',
  'x-content-type-options': 'X-Content-Type-Options',
  'x-frame-options': 'X-Frame-Options',
  'referrer-policy': 'Referrer-Policy',
  'permissions-policy': 'Permissions-Policy',
  'cross-origin-opener-policy': 'COOP',
  'cross-origin-embedder-policy': 'COEP',
  'cross-origin-resource-policy': 'CORP',
}

function AuditReport({ audit }: { audit: SecurityAudit }) {
  const present = audit.securityHeaders.filter((h) => h.present).length
  const total = audit.securityHeaders.length
  const httpsOk = audit.scheme === 'https' && audit.httpsUpgrade !== 'no'

  return (
    <div className="rounded-xl border border-border bg-card/40 p-4 md:p-5">
      <div className="mb-4 flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <ShieldCheck className="size-4" />
        Аудит безопасности
        <span className="ml-auto font-mono text-xs">
          {present}/{total} заголовков защиты
        </span>
      </div>

      {/* Транспорт */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium',
            httpsOk
              ? 'bg-emerald-500/10 text-emerald-500'
              : 'bg-destructive/10 text-destructive',
          )}
        >
          {httpsOk ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
          {audit.scheme.toUpperCase()}
        </span>
        <span className="text-xs text-muted-foreground">
          http→https:{' '}
          {audit.httpsUpgrade === 'yes'
            ? 'редирект есть'
            : audit.httpsUpgrade === 'no'
              ? 'нет редиректа'
              : 'не определено'}
        </span>
        {audit.status !== null && (
          <span className="font-mono text-xs text-muted-foreground">
            HTTP {audit.status}
          </span>
        )}
      </div>

      {/* Заголовки безопасности */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {audit.securityHeaders.map((h) => (
          <div
            key={h.key}
            className="flex items-start gap-2 rounded-lg border border-border/60 bg-background/40 px-3 py-2"
          >
            {h.present ? (
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            ) : (
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            )}
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground">
                {HEADER_LABELS[h.key] ?? h.key}
              </div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {h.present ? h.value || '(включён)' : 'отсутствует'}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Раскрытие версий ПО */}
      {audit.disclosure.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            Раскрытие версий ПО
          </div>
          <div className="flex flex-col gap-1">
            {audit.disclosure.map((h) => (
              <div key={h.key} className="font-mono text-[11px] text-amber-500">
                {h.key}: {h.value}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Cookie */}
      {audit.cookies.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            Cookie (только флаги, значения не читались)
          </div>
          <div className="overflow-hidden rounded-lg border border-border/60">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/60 bg-muted/40 text-left text-muted-foreground">
                  <th className="px-3 py-1.5 font-medium">Имя</th>
                  <th className="px-3 py-1.5 font-medium">Secure</th>
                  <th className="px-3 py-1.5 font-medium">HttpOnly</th>
                  <th className="px-3 py-1.5 font-medium">SameSite</th>
                </tr>
              </thead>
              <tbody>
                {audit.cookies.map((c, i) => (
                  <tr
                    key={`${c.name}-${i}`}
                    className="border-b border-border/40 last:border-0"
                  >
                    <td className="px-3 py-1.5 font-mono text-foreground">
                      {c.name}
                    </td>
                    <td className="px-3 py-1.5">
                      <FlagMark on={c.secure} />
                    </td>
                    <td className="px-3 py-1.5">
                      <FlagMark on={c.httpOnly} />
                    </td>
                    <td className="px-3 py-1.5 font-mono text-muted-foreground">
                      {c.sameSite ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function FlagMark({ on }: { on: boolean }) {
  return on ? (
    <CircleCheck className="size-3.5 text-emerald-500" />
  ) : (
    <CircleAlert className="size-3.5 text-destructive" />
  )
}

/* ------------------------------ S3 UI ----------------------------------- */

const S3_OUTCOME_LABELS: Record<S3ScanResult['probes'][number]['outcome'], string> = {
  'public-listing': 'листинг открыт',
  'access-denied': 'доступ закрыт',
  'not-found': 'не найден',
  redirect: 'редирект',
  error: 'ошибка сети',
  other: 'прочее',
}

function S3Report({ result }: { result: S3ScanResult }) {
  const isPublic = result.verdict === 'public'
  const tone =
    result.verdict === 'public'
      ? 'bad'
      : result.verdict === 'private'
        ? 'good'
        : 'muted'

  const verdictLabel =
    result.verdict === 'public'
      ? 'Публичный листинг открыт'
      : result.verdict === 'private'
        ? 'Листинг закрыт (приватный бакет)'
        : result.verdict === 'not-found'
          ? 'Бакет не найден'
          : 'Состояние не определено'

  return (
    <div className="flex flex-col gap-4">
      {/* Вердикт */}
      <div
        className={cn(
          'flex items-start gap-3 rounded-xl border p-4',
          isPublic
            ? 'border-destructive/40 bg-destructive/10'
            : result.verdict === 'private'
              ? 'border-emerald-500/40 bg-emerald-500/10'
              : 'border-border bg-card/40',
        )}
      >
        {isPublic ? (
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
        ) : result.verdict === 'private' ? (
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-emerald-500" />
        ) : (
          <Boxes className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0">
          <div
            className={cn(
              'text-sm font-semibold',
              isPublic && 'text-destructive',
              result.verdict === 'private' && 'text-emerald-500',
              (result.verdict === 'not-found' || result.verdict === 'unknown') &&
                'text-foreground',
            )}
          >
            {verdictLabel}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-xs text-muted-foreground">
            <span className="text-foreground">{result.bucket}</span>
            {result.region && <span>регион: {result.region}</span>}
            {result.publicListing && result.objectCount !== null && (
              <span>
                объектов: {result.objectCount}
                {result.truncated ? '+' : ''}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Сводка */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={Boxes}
          label="Существует"
          value={
            result.exists === null ? '—' : result.exists ? 'да' : 'нет'
          }
          tone="muted"
        />
        <StatCard
          icon={isPublic ? ShieldAlert : ShieldCheck}
          label="Листинг"
          value={result.publicListing ? 'открыт' : 'закрыт'}
          tone={result.publicListing ? 'bad' : 'good'}
        />
        <StatCard
          icon={Database}
          label="Объектов"
          value={
            result.objectCount !== null
              ? `${result.objectCount}${result.truncated ? '+' : ''}`
              : '—'
          }
          tone="muted"
        />
        <StatCard
          icon={Database}
          label="Регион"
          value={result.region ?? '—'}
          tone="muted"
        />
      </div>

      {/* Примеры ключей при открытом листинге */}
      {result.sampleKeys.length > 0 && (
        <div className="rounded-xl border border-destructive/30 bg-card/40 p-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-destructive">
            <CircleAlert className="size-3.5" />
            Видимые объекты (первые {result.sampleKeys.length})
          </div>
          <div className="flex flex-col gap-1">
            {result.sampleKeys.map((k) => (
              <div
                key={k}
                className="truncate font-mono text-[11px] text-muted-foreground"
              >
                {k}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Пробы эндпоинтов */}
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Эндпоинт</th>
              <th className="px-4 py-2 font-medium">Статус</th>
              <th className="px-4 py-2 font-medium">Задержка</th>
              <th className="px-4 py-2 font-medium">Результат</th>
            </tr>
          </thead>
          <tbody>
            {result.probes.map((p) => (
              <tr
                key={p.url}
                className="border-b border-border/60 last:border-b-0"
              >
                <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                  {p.style}
                </td>
                <td className="px-4 py-2 font-mono">
                  {p.status !== null ? (
                    <StatusBadge status={p.status} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-4 py-2 font-mono">
                  {p.ms !== null ? (
                    `${p.ms} мс`
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-xs">
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5',
                      p.outcome === 'public-listing' && 'text-destructive',
                      p.outcome === 'access-denied' && 'text-emerald-500',
                      p.outcome !== 'public-listing' &&
                        p.outcome !== 'access-denied' &&
                        'text-muted-foreground',
                    )}
                  >
                    {S3_OUTCOME_LABELS[p.outcome]}
                    {p.code ? ` (${p.code})` : ''}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PingReport({ result }: { result: PingResult }) {
  const allLost = result.received === 0

  return (
    <div className="flex flex-col gap-4">
      {/* Заголовок хоста */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-sm font-medium text-foreground">
          {result.host}
        </span>
        {result.ip && (
          <span className="font-mono text-xs text-muted-foreground">
            {result.ip}
          </span>
        )}
      </div>

      {/* Сводка */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={CircleCheck}
          label="Получено"
          value={`${result.received}/${result.attempts.length}`}
          tone={allLost ? 'bad' : 'good'}
        />
        <StatCard
          icon={CircleAlert}
          label="Потеряно"
          value={String(result.lost)}
          tone={result.lost > 0 ? 'bad' : 'muted'}
        />
        <StatCard
          icon={Gauge}
          label="Средняя"
          value={result.avg !== null ? `${result.avg} мс` : '—'}
          tone="muted"
        />
        <StatCard
          icon={Gauge}
          label="Мин / Макс"
          value={
            result.min !== null && result.max !== null
              ? `${result.min} / ${result.max}`
              : '—'
          }
          tone="muted"
        />
      </div>

      {/* Попытки */}
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">#</th>
              <th className="px-4 py-2 font-medium">Статус</th>
              <th className="px-4 py-2 font-medium">Задержка</th>
              <th className="px-4 py-2 font-medium">Результат</th>
            </tr>
          </thead>
          <tbody>
            {result.attempts.map((a) => (
              <tr
                key={a.seq}
                className="border-b border-border/60 last:border-b-0"
              >
                <td className="px-4 py-2 font-mono text-muted-foreground">
                  {a.seq}
                </td>
                <td className="px-4 py-2 font-mono">
                  {a.status !== null ? (
                    <StatusBadge status={a.status} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-4 py-2 font-mono">
                  {a.ms !== null ? (
                    `${a.ms} мс`
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  {a.ms !== null ? (
                    <span className="inline-flex items-center gap-1.5 text-emerald-500">
                      <CircleCheck className="size-3.5" />
                      OK
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-destructive">
                      <CircleAlert className="size-3.5" />
                      {a.error ?? 'Ошибка'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Gauge
  label: string
  value: string
  tone: 'good' | 'bad' | 'muted'
}) {
  return (
    <div className="rounded-xl border border-border bg-card/40 p-3">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div
        className={cn(
          'text-lg font-semibold tracking-tight',
          tone === 'good' && 'text-emerald-500',
          tone === 'bad' && 'text-destructive',
          tone === 'muted' && 'text-foreground',
        )}
      >
        {value}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: number }) {
  const tone =
    status >= 200 && status < 300
      ? 'text-emerald-500'
      : status >= 300 && status < 400
        ? 'text-amber-500'
        : 'text-destructive'
  return <span className={tone}>{status}</span>
}
