'use client'

/**
 * God-панель, вкладка «Ping» — единая проверка своего домена/URL.
 *
 * Владелец вводит ОДИН адрес и жмёт одну кнопку «Проверить». Панель за один
 * проход:
 *   1) меряет доступность и задержку (несколько HTTP-запросов),
 *   2) собирает пассивный аудит безопасности (заголовки защиты, флаги cookie,
 *      раскрытие версий ПО, upgrade http→https),
 *   3) проверяет отражение ввода (риск reflected XSS) безобидным маркером.
 * Ниже — единый отчёт. AI-заключение по харденингу — раскрываемая секция под
 * аудитом (модель зовётся лениво, только при раскрытии).
 *
 * Отдельно — вспомогательное сканирование S3-бакета (принимает имя бакета,
 * а не домен, поэтому вынесено в свою секцию).
 *
 * Часть скрытой панели: подчиняется инвариантам AGENTS.md §4 (обычная админка
 * и Admin AI о вкладке не знают, сервер-экшены не пишут в audit). Все проверки
 * строго ПАССИВНЫЕ и защитные: инструмент только читает публично наблюдаемый
 * ответ, ничего не эксплуатирует, не пишет и не удаляет.
 */

import { useState } from 'react'
import { toast } from 'sonner'
import {
  Activity,
  ArrowRight,
  Boxes,
  Bug,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Copy,
  Database,
  FileWarning,
  Gauge,
  Globe,
  KeyRound,
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
  type DnsHygiene,
  type PathLeak,
  type PingResult,
  type ReflectionCheck,
  type S3ScanResult,
  type SecurityAudit,
  type SecurityScore,
  type TlsCheck,
} from '@/app/actions/admin-secret'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Markdown } from '@/components/admin/secret-markdown'
import { cn } from '@/lib/utils'

const ATTEMPT_OPTIONS = [1, 2, 4, 6]

/** Похож ли ввод на адрес S3-бакета (для авто-скана в едином прогоне). */
function looksLikeS3(raw: string): boolean {
  const s = raw.trim().toLowerCase()
  return (
    /\.s3[.-][a-z0-9-]*\.?amazonaws\.com/.test(s) ||
    /(^|\/\/)s3[.-][a-z0-9-]*\.?amazonaws\.com\//.test(s)
  )
}

export function SecretPingTab() {
  const [url, setUrl] = useState('')
  const [attempts, setAttempts] = useState(4)

  // Единый прогон: ping + аудит (+ отражение) одной кнопкой.
  const [scanPending, setScanPending] = useState(false)
  const [pingResult, setPingResult] = useState<PingResult | null>(null)
  const [audit, setAudit] = useState<SecurityAudit | null>(null)
  const [scanned, setScanned] = useState(false)

  // AI-заключение — ленивая раскрываемая секция под аудитом.
  const [assessOpen, setAssessOpen] = useState(false)
  const [assessPending, setAssessPending] = useState(false)
  const [assessment, setAssessment] = useState<string | null>(null)

  // Результат S3-скана (запускается автоматически, если адрес похож на бакет).
  const [s3Result, setS3Result] = useState<S3ScanResult | null>(null)

  async function runFullScan() {
    const target = url.trim()
    if (!target) {
      toast.error('Введите домен или URL')
      return
    }
    const isS3 = looksLikeS3(target)
    setScanPending(true)
    setPingResult(null)
    setAudit(null)
    setS3Result(null)
    setAssessment(null)
    setAssessOpen(false)
    setScanned(true)
    try {
      // Всегда меряем доступность. Затем, в зависимости от типа адреса,
      // либо сканируем S3-бакет, либо собираем веб-аудит (веб-аудит на
      // адресе бакета бессмысленен, поэтому для S3 его пропускаем).
      const tasks: Promise<void>[] = [
        secretPingAction(target, attempts).then((ping) => {
          if (ping.ok && ping.data) {
            setPingResult(ping.data)
            if (ping.data.received === 0) toast.error(ping.message)
          } else {
            toast.error(ping.message)
          }
        }),
      ]

      if (isS3) {
        tasks.push(
          secretS3ScanAction(target).then((res) => {
            if (res.ok && res.data) {
              setS3Result(res.data)
              if (res.data.verdict === 'public') toast.error(res.message)
            } else {
              toast.error(res.message)
            }
          }),
        )
      } else {
        tasks.push(
          secretSecurityAuditAction(target).then((sec) => {
            if (sec.data) setAudit(sec.data)
            if (!sec.ok && !sec.data) toast.error(sec.message)
          }),
        )
      }

      await Promise.all(tasks)
    } catch {
      toast.error('Внутренняя ошибка при проверке')
    } finally {
      setScanPending(false)
    }
  }

  async function toggleAssess() {
    const next = !assessOpen
    setAssessOpen(next)
    if (!next || assessment || assessPending) return

    const target = url.trim()
    if (!target) return
    setAssessPending(true)
    try {
      const res = await secretSecurityAssessAction(target)
      if (res.audit) setAudit(res.audit)
      if (res.ok && res.report) {
        setAssessment(res.report)
      } else {
        toast.error(res.message)
        setAssessOpen(false)
      }
    } catch {
      toast.error('Внутренняя ошибка при формировании заключения')
      setAssessOpen(false)
    } finally {
      setAssessPending(false)
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
      {/* ---- Единый ввод адреса + одна кнопка ---- */}
      <div className="rounded-xl border border-border bg-card/40 p-4 md:p-5">
        <div className="mb-1 flex items-center gap-2 text-sm font-medium text-foreground">
          <Radio className="size-4 text-primary" />
          Проверка домена
        </div>
        <p className="mb-4 text-xs text-muted-foreground text-pretty">
          Один адрес — полный отчёт со сводной оценкой: доступность и задержка,
          заголовки защиты, TLS-сертификат, отражение ввода (reflected XSS),
          типовые утечки путей, DNS/почтовая гигиена (SPF/DMARC/DKIM/CAA), cookie
          и раскрытие версий ПО. Если адрес похож на S3 — бакет сканируется
          автоматически. Всё пассивно — только чтение ответа.
        </p>

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
                  !scanPending
                ) {
                  void runFullScan()
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
            onClick={() => void runFullScan()}
            disabled={scanPending}
            className="press-scale gap-1.5"
          >
            {scanPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowRight className="size-4" />
            )}
            Проверить
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Попыток ping:</span>
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
        </div>
      </div>

      {/* ---- Единый отчёт: доступность → безопасность → AI ---- */}
      {scanPending && !pingResult && !audit && !s3Result && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-card/40 p-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Проверяю доступность и конфигурацию…
        </div>
      )}

      {pingResult && (
        <SectionCard icon={Gauge} title="Доступность и задержка">
          <PingReport result={pingResult} />
        </SectionCard>
      )}

      {audit && (
        <SectionCard
          icon={ShieldCheck}
          title="Безопасность"
          right={<ScoreBadge score={audit.score} />}
        >
          <AuditBody audit={audit} />

          {/* AI-заключение — раскрываемая секция под аудитом */}
          <div className="mt-4 border-t border-border/60 pt-3">
            <button
              type="button"
              onClick={() => void toggleAssess()}
              className="press-scale flex w-full items-center gap-2 text-sm font-medium text-foreground"
              aria-expanded={assessOpen}
            >
              <Sparkles className="size-4 text-primary" />
              AI-заключение по защищённости
              {assessPending && (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              )}
              <ChevronDown
                className={cn(
                  'ml-auto size-4 text-muted-foreground transition-transform',
                  assessOpen && 'rotate-180',
                )}
              />
            </button>

            {assessOpen && (
              <div className="mt-3">
                {assessPending ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    Анализирую конфигурацию и составляю рекомендации…
                  </div>
                ) : assessment ? (
                  <div>
                    <div className="mb-2 flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void copyAssessment()}
                        className="size-7"
                        aria-label="Скопировать заключение"
                      >
                        <Copy className="size-3.5" />
                      </Button>
                    </div>
                    <Markdown text={assessment} />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Не удалось получить заключение. Попробуйте ещё раз.
                  </p>
                )}
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {/* S3-бакет: сканируется автоматически, если адрес похож на бакет. */}
      {s3Result && (
        <SectionCard icon={Boxes} title="S3-бакет">
          <S3Report result={s3Result} />
        </SectionCard>
      )}

      {!scanned && !scanPending && (
        <p className="px-1 text-sm text-muted-foreground text-pretty">
          Введите свой домен или адрес страницы состояния и нажмите «Проверить».
          Панель за один проход измерит доступность, соберёт аудит безопасности и
          проверит отражение ввода, а по кнопке ниже отчёта AI даст рекомендации
          по харденингу. Если адрес похож на S3-бакет — вместо веб-аудита
          автоматически запускается проверка публичного листинга бакета.
        </p>
      )}
    </div>
  )
}

/* --------------------------- Оболочка секции ---------------------------- */

function SectionCard({
  icon: Icon,
  title,
  right,
  children,
}: {
  icon: typeof Gauge
  title: string
  right?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border bg-card/40 p-4 md:p-5">
      <div className="mb-4 flex items-center gap-2 text-sm font-medium text-foreground">
        <Icon className="size-4 text-primary" />
        {title}
        {right && <span className="ml-auto">{right}</span>}
      </div>
      {children}
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

function AuditBody({ audit }: { audit: SecurityAudit }) {
  // Бейдж отражает ТОЛЬКО схему соединения. Наличие http→https-редиректа —
  // отдельный факт, он показан соседней строкой, смешивать их нельзя.
  const httpsOk = audit.scheme === 'https'

  return (
    <>
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
          {httpsOk ? (
            <Lock className="size-3.5" />
          ) : (
            <LockOpen className="size-3.5" />
          )}
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

      {/* TLS-сертификат */}
      <TlsCard tls={audit.tls} />

      {/* Отражение ввода (reflected XSS) */}
      <ReflectionCard reflection={audit.reflection} />

      {/* Утечки типовых путей */}
      <PathLeaksCard leaks={audit.pathLeaks} />

      {/* DNS / почтовая гигиена */}
      <DnsCard dns={audit.dns} />

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
    </>
  )
}

const REFLECTION_TONE: Record<
  ReflectionCheck['risk'],
  { border: string; text: string; label: string }
> = {
  none: {
    border: 'border-emerald-500/30 bg-emerald-500/5',
    text: 'text-emerald-500',
    label: 'Риск не обнаружен',
  },
  low: {
    border: 'border-emerald-500/30 bg-emerald-500/5',
    text: 'text-emerald-500',
    label: 'Низкий риск',
  },
  medium: {
    border: 'border-amber-500/40 bg-amber-500/10',
    text: 'text-amber-500',
    label: 'Средний риск',
  },
  high: {
    border: 'border-destructive/40 bg-destructive/10',
    text: 'text-destructive',
    label: 'Высокий риск',
  },
}

function ReflectionCard({ reflection }: { reflection: ReflectionCheck }) {
  const tone = REFLECTION_TONE[reflection.risk]
  const alarming = reflection.risk === 'medium' || reflection.risk === 'high'

  return (
    <div className={cn('mt-4 rounded-lg border p-3', tone.border)}>
      <div className="flex items-center gap-2">
        {alarming ? (
          <Bug className={cn('size-4 shrink-0', tone.text)} />
        ) : (
          <ShieldCheck className={cn('size-4 shrink-0', tone.text)} />
        )}
        <span className="text-xs font-medium text-foreground">
          Отражение ввода (reflected XSS)
        </span>
        <span
          className={cn('ml-auto text-xs font-semibold', tone.text)}
        >
          {reflection.tested ? tone.label : 'Не проверено'}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground text-pretty">
        {reflection.note}
      </p>
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

/* --------------------------- Сводная оценка ----------------------------- */

/** Тон бейджа по буквенной оценке. */
function gradeTone(grade: SecurityScore['grade']): string {
  if (grade === 'A' || grade === 'B') return 'bg-emerald-500/10 text-emerald-500'
  if (grade === 'C' || grade === 'D') return 'bg-amber-500/10 text-amber-500'
  return 'bg-destructive/10 text-destructive'
}

function ScoreBadge({ score }: { score: SecurityScore }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold',
        gradeTone(score.grade),
      )}
      title={
        score.deductions.length
          ? score.deductions.map((d) => `−${d.points} ${d.reason}`).join(' · ')
          : 'Замечаний не найдено'
      }
    >
      <Gauge className="size-3.5" />
      {score.value}/100 · {score.grade}
    </span>
  )
}

/* ----------------------------- TLS-карточка ----------------------------- */

const TLS_TONE: Record<TlsCheck['status'], { border: string; text: string; label: string }> = {
  ok: { border: 'border-emerald-500/30 bg-emerald-500/5', text: 'text-emerald-500', label: 'Сертификат в порядке' },
  warn: { border: 'border-amber-500/40 bg-amber-500/10', text: 'text-amber-500', label: 'Требует внимания' },
  bad: { border: 'border-destructive/40 bg-destructive/10', text: 'text-destructive', label: 'Проблема с сертификатом' },
  unknown: { border: 'border-border/60 bg-background/40', text: 'text-muted-foreground', label: 'Не проверено' },
}

function TlsCard({ tls }: { tls: TlsCheck }) {
  const tone = TLS_TONE[tls.status]
  return (
    <div className={cn('mt-4 rounded-lg border p-3', tone.border)}>
      <div className="flex items-center gap-2">
        <KeyRound className={cn('size-4 shrink-0', tone.text)} />
        <span className="text-xs font-medium text-foreground">TLS-сертификат</span>
        <span className={cn('ml-auto text-xs font-semibold', tone.text)}>
          {tone.label}
        </span>
      </div>
      {tls.tested ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
          {tls.protocol && <span>протокол: {tls.protocol}</span>}
          {tls.issuer && <span>издатель: {tls.issuer}</span>}
          {tls.daysLeft !== null && (
            <span className={tls.daysLeft <= 14 ? tone.text : undefined}>
              осталось: {tls.daysLeft} дн.
            </span>
          )}
          <span className={tls.hostnameMatch ? undefined : 'text-destructive'}>
            имя хоста: {tls.hostnameMatch ? 'совпадает' : 'не совпадает'}
          </span>
        </div>
      ) : (
        <p className="mt-1.5 text-[11px] text-muted-foreground">{tls.note}</p>
      )}
    </div>
  )
}

/* -------------------------- Утечки путей -------------------------------- */

function PathLeaksCard({ leaks }: { leaks: PathLeak[] }) {
  if (leaks.length === 0) return null
  const exposed = leaks.filter((p) => p.exposed && p.severity !== 'info')
  const clean = exposed.length === 0

  return (
    <div
      className={cn(
        'mt-4 rounded-lg border p-3',
        clean
          ? 'border-emerald-500/30 bg-emerald-500/5'
          : 'border-destructive/40 bg-destructive/10',
      )}
    >
      <div className="flex items-center gap-2">
        <FileWarning
          className={cn(
            'size-4 shrink-0',
            clean ? 'text-emerald-500' : 'text-destructive',
          )}
        />
        <span className="text-xs font-medium text-foreground">
          Типовые пути
        </span>
        <span
          className={cn(
            'ml-auto text-xs font-semibold',
            clean ? 'text-emerald-500' : 'text-destructive',
          )}
        >
          {clean ? 'Ничего не открыто' : `Открыто: ${exposed.length}`}
        </span>
      </div>
      {clean ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Чувствительные пути (.env, .git, бэкапы) наружу не отдаются.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-1">
          {exposed.map((p) => (
            <div
              key={p.path}
              className={cn(
                'flex items-center gap-2 font-mono text-[11px]',
                p.severity === 'critical' ? 'text-destructive' : 'text-amber-500',
              )}
            >
              <CircleAlert className="size-3.5 shrink-0" />
              {p.path}
              <span className="text-muted-foreground">HTTP {p.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* -------------------------- DNS / почта --------------------------------- */

function DnsCard({ dns }: { dns: DnsHygiene }) {
  if (!dns.tested) return null
  const rows: { label: string; ok: boolean; extra?: string }[] = [
    { label: 'SPF', ok: dns.spf },
    {
      label: 'DMARC',
      ok: dns.dmarc,
      extra: dns.dmarc && dns.dmarcPolicy ? `p=${dns.dmarcPolicy}` : undefined,
    },
    { label: 'DKIM', ok: dns.dkim },
    { label: 'CAA', ok: dns.caa },
  ]
  return (
    <div className="mt-4 rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Globe className="size-4 shrink-0 text-primary" />
        <span className="text-xs font-medium text-foreground">
          DNS и почтовая гигиена
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-center gap-2 rounded-md border border-border/60 bg-card/40 px-2.5 py-1.5"
          >
            <FlagMark on={r.ok} />
            <span className="text-xs font-medium text-foreground">
              {r.label}
            </span>
            {r.extra && (
              <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                {r.extra}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------ S3 UI ----------------------------------- */

const S3_OUTCOME_LABELS: Record<
  S3ScanResult['probes'][number]['outcome'],
  string
> = {
  'public-listing': 'листинг открыт',
  'access-denied': 'доступ закрыт',
  'not-found': 'не найден',
  redirect: 'редирект',
  error: 'ошибка сети',
  other: 'прочее',
}

function S3Report({ result }: { result: S3ScanResult }) {
  const isPublic = result.verdict === 'public'

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
              (result.verdict === 'not-found' ||
                result.verdict === 'unknown') &&
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
          value={result.exists === null ? '—' : result.exists ? 'да' : 'нет'}
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
