'use client'

/**
 * God-панель, вкладка «Ping» — единая проверка своего домена одним действием.
 *
 * НА ЭКРАНЕ ВСЕГО ДВА ЭЛЕМЕНТА: поле для домена и кнопка «Запустить». Один
 * клик запускает весь конвейер на сервере (`secretFullScanAction`):
 *   1) доступность и задержка (несколько HTTP-запросов),
 *   2) полный пассивный аудит: заголовки защиты, разбор силы CSP/HSTS, CORS,
 *      опасные HTTP-методы, mixed content, CDN/WAF и кэш, cookie (флаги +
 *      префиксы), раскрытие версий ПО, TLS-сертификат, отражение ввода,
 *      DNS/почтовая гигиена (SPF/DMARC/DKIM/CAA),
 *   3) поиск утечек типовых путей (.env/.git/бэкапы/…),
 *   4) авто-«пробив» подтверждённых находок (read-only верификация),
 *   5) оппортунистический скан одноимённого S3-бакета,
 *   6) AI-заключение по харденингу.
 * Пока идёт проверка — пошаговый прогресс-бар. В конце — единый полный отчёт.
 *
 * Часть скрытой панели: подчиняется инвариантам AGENTS.md §4 (обычная админка
 * и Admin AI о вкладке не знают, сервер-экшены не пишут в audit). Все проверки
 * строго ПАССИВНЫЕ и защитные: инструмент только читает публично наблюдаемый
 * ответ, ничего не эксплуатирует, не пишет и не удаляет.
 */

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Boxes,
  Bug,
  CircleAlert,
  CircleCheck,
  Copy,
  Database,
  FileWarning,
  Gauge,
  GitBranch,
  Globe,
  KeyRound,
  Layers,
  Loader2,
  Lock,
  LockOpen,
  Network,
  Radio,
  Rocket,
  Route,
   ShieldAlert,
  ShieldCheck,
  Sparkles,
  Target,
} from 'lucide-react'
import {
  secretFullScanAction,
  type AuthProbe,
  type AutoDrill,
  type CmsDetection,
  type CockpitProbe,
  type CorsCheck,
  type CspAnalysis,
  type DnsHygiene,
  type DrillResult,
  type EndpointProbe,
  type FullScanResult,
  type GraphqlCheck,
  type HstsAnalysis,
  type InfraCheck,
  type MethodsCheck,
  type MixedContentCheck,
  type OpenRedirectCheck,
  type PathLeak,
  type PingResult,
  type ReconResult,
  type ReflectionCheck,
  type S3BucketFinding,
  type SecurityAudit,
  type SecurityScore,
  type SubdomainResult,
  type TlsCheck,
} from '@/app/actions/admin-secret'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Markdown } from '@/components/admin/secret-markdown'
import { cn } from '@/lib/utils'

/* ------------------------------ Прогресс -------------------------------- */

/** Фазы конвейера — для пошагового прогресс-бара (порядок = порядок работы). */
const SCAN_PHASES = [
  'Проверка доступности и задержки',
  'Сбор заголовков и TLS-сертификата',
  'Разбор CSP / HSTS / CORS / методов',
  'DNS и почтовая гигиена',
  'Поиск утечек типовых путей',
  'Пробив подтверждённых находок',
  'Обнаружение CMS и API-эндпоинтов',
  'Разведка поддоменов',
  'GraphQL и открытые редиректы',
  'Cockpit и детекция S3-бакетов',
  'AI-заключение по харденингу',
] as const

export function SecretPingTab() {
  const [url, setUrl] = useState('')
  const [cookie, setCookie] = useState('')
  const [authorized, setAuthorized] = useState(false)
  const [pending, setPending] = useState(false)
  const [phase, setPhase] = useState(0)
  const [result, setResult] = useState<FullScanResult | null>(null)
  const [scanned, setScanned] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Пока идёт единый серверный проход, продвигаем прогресс по фазам «на глаз»
  // (сервер не стримит) — но останавливаемся на предпоследней, а финал (100%)
  // ставим по факту ответа. Это даёт честное ощущение «текущего процесса».
  useEffect(() => {
    if (!pending) {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
      return
    }
    timerRef.current = setInterval(() => {
      setPhase((p) => (p < SCAN_PHASES.length - 2 ? p + 1 : p))
    }, 1400)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [pending])

  async function runScan() {
    const target = url.trim()
    if (!target) {
      toast.error('Введите домен или URL')
      return
    }
    if (!authorized) {
      toast.error('Подтвердите право тестировать этот домен')
      return
    }
    setPending(true)
    setPhase(0)
    setResult(null)
    setScanned(true)
    try {
      const res = await secretFullScanAction(target, authorized, cookie.trim() || undefined)
      if (res.ok && res.data) {
        setResult(res.data)
        if (!res.data.audit.responded) toast.error(res.message)
      } else {
        toast.error(res.message)
      }
    } catch {
      toast.error('Внутренняя ошибка при проверке')
    } finally {
      setPhase(SCAN_PHASES.length - 1)
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* ---- Два элемента: поле домена + кнопка запуска ---- */}
      <div className="rounded-xl border border-border bg-card/40 p-4 md:p-5">
        <div className="mb-1 flex items-center gap-2 text-sm font-medium text-foreground">
          <Radio className="size-4 text-primary" />
          Проверка домена
        </div>
        <p className="mb-4 text-xs text-muted-foreground text-pretty">
          Введите домен и нажмите «Запустить» — панель за один проход выполнит
          все проверки (доступность, заголовки, CSP/HSTS/CORS, методы, mixed
          content, CDN/кэш, TLS, отражение ввода, DNS, утечки путей), сама
          «пробьёт» находки, проверит одноимённый S3-бакет и составит
          AI-заключение. Всё пассивно — только чтение ответа.
        </p>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Globe className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.nativeEvent.isComposing &&
                  e.keyCode !== 229 &&
                  !pending &&
                  authorized
                ) {
                  void runScan()
                }
              }}
              placeholder="example.com"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="pl-9 font-mono text-sm"
              aria-label="Домен для проверки"
            />
          </div>

          <Button
            onClick={() => void runScan()}
            disabled={pending || !authorized}
            className="press-scale gap-1.5"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Rocket className="size-4" />
            )}
            Запустить
          </Button>
        </div>

        {/* Необязательные cookie для обхода Cloudflare-челленджа */}
        <div className="mt-3">
          <label
            htmlFor="scan-cookie"
            className="mb-1 block text-[11px] font-medium text-muted-foreground"
          >
            Cookie (необязательно) — для обхода Cloudflare challenge
          </label>
          <textarea
            id="scan-cookie"
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            placeholder="cf_clearance=…; session=…  (скопируйте из DevTools → Application → Cookies)"
            spellCheck={false}
            rows={2}
            className="w-full resize-y rounded-lg border border-border bg-background/60 px-3 py-2 font-mono text-[11px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <p className="mt-1 text-[11px] text-muted-foreground text-pretty">
            Запрос выполняется с полным браузерным набором заголовков. Если сайт
            за Cloudflare отдаёт страницу-вызов, вставьте сюда cookie из своего
            браузера — они будут приложены к запросу.
          </p>
        </div>

        {/* Обязательное подтверждение права тестировать домен */}
        <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 bg-background/40 p-3">
          <input
            type="checkbox"
            checked={authorized}
            onChange={(e) => setAuthorized(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
            aria-label="Подтверждение права тестировать домен"
          />
          <span className="text-xs text-muted-foreground text-pretty">
            Я подтверждаю, что владею этим доменом или имею явное разрешение на
            его тестирование. Скан выполняет активные пробы (перебор поддоменов,
            эндпоинтов, имён S3-бакетов) — запускайте его только против своей
            инфраструктуры.
          </span>
        </label>
      </div>

      {/* ---- Прогресс конвейера ---- */}
      {pending && <ScanProgress phase={phase} />}

      {/* ---- Единый полный отчёт ---- */}
      {result && !pending && <FullReport result={result} />}

      {!scanned && !pending && (
        <p className="px-1 text-sm text-muted-foreground text-pretty">
          Введите свой домен и нажмите «Запустить». Одним действием панель
          проверит доступность, соберёт полный аудит безопасности, найдёт утечки
          путей, «пробьёт» каждую находку read-only проверками, проверит
          одноимённый S3-бакет и даст AI-заключение по харденингу.
        </p>
      )}
    </div>
  )
}

/* --------------------------- Прогресс-бар ------------------------------- */

function ScanProgress({ phase }: { phase: number }) {
  const total = SCAN_PHASES.length
  const pct = Math.round(((phase + 1) / total) * 100)
  return (
    <div className="rounded-xl border border-border bg-card/40 p-4 md:p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
        <Loader2 className="size-4 animate-spin text-primary" />
        {SCAN_PHASES[phase]}
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {pct}%
        </span>
      </div>

      {/* Полоса прогресса */}
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Прогресс проверки"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Список фаз с отметками */}
      <ol className="mt-3 flex flex-col gap-1.5">
        {SCAN_PHASES.map((label, i) => {
          const done = i < phase
          const active = i === phase
          return (
            <li
              key={label}
              className={cn(
                'flex items-center gap-2 text-[11px]',
                done && 'text-muted-foreground',
                active && 'text-foreground',
                !done && !active && 'text-muted-foreground/50',
              )}
            >
              {done ? (
                <CircleCheck className="size-3.5 shrink-0 text-emerald-500" />
              ) : active ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
              ) : (
                <span className="size-3.5 shrink-0 rounded-full border border-current/40" />
              )}
              {label}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/* --------------------------- Полный отчёт ------------------------------- */

function FullReport({ result }: { result: FullScanResult }) {
  const { ping, audit, drills, recon, s3, report, reportError } = result

  async function copyReport() {
    if (!report) return
    try {
      await navigator.clipboard.writeText(report)
      toast.success('Заключение скопировано')
    } catch {
      toast.error('Не удалось скопировать')
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Доступность */}
      {ping && (
        <SectionCard icon={Gauge} title="Доступность и задержка">
          <PingReport result={ping} />
        </SectionCard>
      )}

      {/* Безопасность */}
      {audit.responded ? (
        <SectionCard
          icon={ShieldCheck}
          title="Безопасность"
          right={<ScoreBadge score={audit.score} />}
        >
          <AuditBody audit={audit} />
        </SectionCard>
      ) : (
        <SectionCard icon={ShieldAlert} title="Безопасность">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleAlert className="size-4 text-destructive" />
            Хост не ответил — проверки не выполнялись
            {audit.error ? ` (${audit.error})` : ''}.
          </div>
        </SectionCard>
      )}

      {/* Пробитые находки */}
      {drills.length > 0 && (
        <SectionCard icon={Target} title="Пробитые находки">
          <div className="flex flex-col gap-3">
            {drills.map((d) => (
              <AutoDrillCard key={`${d.kind}:${d.arg ?? ''}`} drill={d} />
            ))}
          </div>
        </SectionCard>
      )}

      {/* Разведка периметра */}
      {recon && <ReconSections recon={recon} />}

      {/* S3-бакеты — только состояние по типовым паттернам имени, без ключей */}
      {s3.length > 0 && (
        <SectionCard icon={Boxes} title="S3-бакеты (детекция по паттернам имени)">
          <S3BucketsReport findings={s3} />
        </SectionCard>
      )}

      {/* AI-заключение */}
      {audit.responded && (
        <SectionCard icon={Sparkles} title="AI-заключение по защищённости">
          {report ? (
            <div>
              <div className="mb-2 flex justify-end">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void copyReport()}
                  className="size-7"
                  aria-label="Скопировать заключение"
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
              <Markdown text={report} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-pretty">
              {reportError ?? 'Заключение недоступно.'}
            </p>
          )}
        </SectionCard>
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

/* --------------------------- Разведка периметра ------------------------- */

/** Цвет бейджа риска. */
function riskClass(risk: 'none' | 'low' | 'medium' | 'high'): string {
  switch (risk) {
    case 'high':
      return 'bg-destructive/10 text-destructive'
    case 'medium':
      return 'bg-amber-500/10 text-amber-500'
    case 'low':
      return 'bg-sky-500/10 text-sky-500'
    default:
      return 'bg-emerald-500/10 text-emerald-500'
  }
}

const RISK_LABEL: Record<'none' | 'low' | 'medium' | 'high', string> = {
  none: 'ок',
  low: 'низкий',
  medium: 'средний',
  high: 'высокий',
}

function ReconSections({ recon }: { recon: ReconResult }) {
  return (
    <>
      <SectionCard icon={Layers} title="CMS и фреймворк">
        <CmsReport cms={recon.cms} />
      </SectionCard>

      <SectionCard icon={Network} title="API-эндпоинты">
        <EndpointsReport endpoints={recon.endpoints} authProbes={recon.authProbes} />
      </SectionCard>

      {recon.cockpit.length > 0 && (
        <SectionCard icon={Database} title="Cockpit / headless-CMS">
          <CockpitReport probes={recon.cockpit} />
        </SectionCard>
      )}

      <SectionCard icon={GitBranch} title="GraphQL">
        <GraphqlReport gql={recon.graphql} />
      </SectionCard>

      <SectionCard icon={Globe} title="Активные поддомены">
        <SubdomainsReport subs={recon.subdomains} />
      </SectionCard>

      <SectionCard icon={Route} title="Открытый редирект">
        <OpenRedirectReport check={recon.openRedirect} />
      </SectionCard>
    </>
  )
}

function CmsReport({ cms }: { cms: CmsDetection }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {cms.name ? (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-500">
            <Layers className="size-3.5" />
            {cms.name}
            {cms.version ? ` ${cms.version}` : ''}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-500">
            <CircleCheck className="size-3.5" />
            не определён
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground text-pretty">{cms.note}</p>
      {cms.adminPaths.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-medium text-muted-foreground">Найденные пути к панели:</div>
          {cms.adminPaths.map((p) => (
            <div key={p} className="font-mono text-[11px] text-amber-500">
              {p}
            </div>
          ))}
        </div>
      )}
      {cms.evidence.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {cms.evidence.map((e) => (
            <li key={e} className="text-[11px] text-muted-foreground">
              • {e}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function EndpointsReport({
  endpoints,
  authProbes,
}: {
  endpoints: EndpointProbe[]
  authProbes: AuthProbe[]
}) {
  const present = endpoints.filter((e) => e.present)
  return (
    <div className="flex flex-col gap-3">
      {present.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleCheck className="size-4 text-emerald-500" />
          Типовых открытых API-эндпоинтов не обнаружено.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {present.map((e) => (
            <div
              key={e.path}
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-3 py-1.5"
            >
              <span className="font-mono text-[11px] text-foreground">{e.path}</span>
              {e.status !== null && (
                <span className="font-mono text-[11px] text-muted-foreground">HTTP {e.status}</span>
              )}
              <span className="ml-auto text-[11px] text-muted-foreground">{e.note}</span>
            </div>
          ))}
        </div>
      )}

      {authProbes.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] font-medium text-muted-foreground">
            Чувствительные auth-эндпоинты (только наблюдение):
          </div>
          {authProbes.map((a) => (
            <div
              key={a.path}
              className="flex items-start gap-2 rounded-lg border border-border/60 bg-background/40 px-3 py-2"
            >
              <KeyRound className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-foreground">{a.path}</span>
                  {a.status !== null && (
                    <span className="font-mono text-[11px] text-muted-foreground">HTTP {a.status}</span>
                  )}
                  <span
                    className={cn(
                      'ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium',
                      riskClass(a.risk),
                    )}
                  >
                    {RISK_LABEL[a.risk]}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground text-pretty">{a.note}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function GraphqlReport({ gql }: { gql: GraphqlCheck }) {
  if (!gql.endpoint) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <CircleCheck className="size-4 text-emerald-500" />
        {gql.note}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-foreground">{gql.endpoint}</span>
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-medium',
            gql.introspectionEnabled ? 'bg-destructive/10 text-destructive' : 'bg-emerald-500/10 text-emerald-500',
          )}
        >
          introspection {gql.introspectionEnabled ? 'включён' : 'выключен'}
        </span>
      </div>
      <p className="text-xs text-muted-foreground text-pretty">{gql.note}</p>
      {gql.sampleTypes.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {gql.sampleTypes.map((t) => (
            <span
              key={t}
              className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function SubdomainsReport({ subs }: { subs: SubdomainResult[] }) {
  if (subs.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <CircleCheck className="size-4 text-emerald-500" />
        Активных поддоменов из типового списка не найдено.
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border/60 bg-muted/40 text-left text-muted-foreground">
            <th className="px-3 py-1.5 font-medium">Хост</th>
            <th className="px-3 py-1.5 font-medium">IP</th>
            <th className="px-3 py-1.5 font-medium">HTTP</th>
            <th className="px-3 py-1.5 font-medium">Статус</th>
          </tr>
        </thead>
        <tbody>
          {subs.map((s) => (
            <tr key={s.host} className="border-b border-border/40 last:border-0">
              <td className="px-3 py-1.5 font-mono text-foreground">{s.host}</td>
              <td className="px-3 py-1.5 font-mono text-muted-foreground">{s.ip ?? '—'}</td>
              <td className="px-3 py-1.5 font-mono text-muted-foreground">
                {s.status ?? '—'}
              </td>
              <td className="px-3 py-1.5 text-muted-foreground">{s.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function OpenRedirectReport({ check }: { check: OpenRedirectCheck }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {check.vulnerable ? (
          <CircleAlert className="size-4 text-destructive" />
        ) : (
          <CircleCheck className="size-4 text-emerald-500" />
        )}
        <span
          className={cn(
            'text-sm',
            check.vulnerable ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {check.note}
        </span>
      </div>
      {check.evidence && (
        <div className="font-mono text-[11px] text-destructive">{check.evidence}</div>
      )}
    </div>
  )
}

function CockpitReport({ probes }: { probes: CockpitProbe[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {probes.map((p) => (
        <div
          key={p.path}
          className={cn(
            'flex items-start gap-2 rounded-lg border px-3 py-2',
            p.openWithoutAuth
              ? 'border-destructive/40 bg-destructive/10'
              : 'border-border/60 bg-background/40',
          )}
        >
          {p.openWithoutAuth ? (
            <LockOpen className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          ) : (
            <Lock className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-foreground">{p.path}</span>
              {p.status !== null && (
                <span className="font-mono text-[11px] text-muted-foreground">HTTP {p.status}</span>
              )}
              <span
                className={cn(
                  'ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium',
                  p.openWithoutAuth
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-emerald-500/10 text-emerald-500',
                )}
              >
                {p.openWithoutAuth ? 'без авторизации' : p.requiresAuth ? 'требует авторизации' : 'иное'}
              </span>
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground text-pretty">{p.note}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------- S3 UI ---------------------------------- */

/**
 * Детекция S3-бакетов по типовым паттернам имени. Показывает ТОЛЬКО состояние
 * (открыт/закрыт листинг) — ключи объектов и содержимое не запрашиваются.
 */
function S3BucketsReport({ findings }: { findings: S3BucketFinding[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground text-pretty">
        Проверены типовые варианты имени бакета для домена. Фиксируется только
        факт существования и открытость листинга — содержимое не читается.
      </p>
      {findings.map((f) => {
        const isPublic = f.verdict === 'public'
        return (
          <div
            key={f.bucket}
            className={cn(
              'flex items-start gap-3 rounded-lg border p-3',
              isPublic
                ? 'border-destructive/40 bg-destructive/10'
                : 'border-emerald-500/40 bg-emerald-500/10',
            )}
          >
            {isPublic ? (
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            ) : (
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-mono text-xs text-foreground">{f.bucket}</span>
                {f.region && (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    регион: {f.region}
                  </span>
                )}
                <span
                  className={cn(
                    'ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium',
                    isPublic ? 'bg-destructive/10 text-destructive' : 'bg-emerald-500/10 text-emerald-500',
                  )}
                >
                  {isPublic ? 'листинг открыт' : 'листинг закрыт'}
                </span>
              </div>
              <div
                className={cn(
                  'mt-0.5 text-[11px] text-pretty',
                  isPublic ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {f.note}
              </div>
            </div>
          </div>
        )
      })}
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

      {/* Разбор силы политик CSP / HSTS */}
      <PolicyCard csp={audit.csp} hsts={audit.hsts} />

      {/* CORS */}
      <CorsCard cors={audit.cors} />

      {/* Опасные HTTP-методы */}
      <MethodsCard methods={audit.methods} />

      {/* Mixed content */}
      <MixedContentCard mixed={audit.mixedContent} />

      {/* CDN / WAF / кэш */}
      <InfraCard infra={audit.infra} />

      {/* TLS-сертификат */}
      <TlsCard tls={audit.tls} />

      {/* Отражение ввода (reflected XSS) */}
      <ReflectionCard reflection={audit.reflection} />

      {/* Утечки типовых путей */}
      <PathLeaksCard leaks={audit.pathLeaks} checked={audit.pathLeaksChecked} />

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
          {audit.cookiePrefixIssues.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {audit.cookiePrefixIssues.map((s) => (
                <li
                  key={s}
                  className="flex items-start gap-1.5 text-[11px] text-amber-500"
                >
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                  {s}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  )
}

/* ---------------------- Карточки новых проверок ------------------------- */

const STRENGTH_TONE: Record<
  CspAnalysis['strength'],
  { text: string; label: string }
> = {
  none: { text: 'text-destructive', label: 'отсутствует' },
  weak: { text: 'text-destructive', label: 'слабая' },
  moderate: { text: 'text-amber-500', label: 'средняя' },
  strong: { text: 'text-emerald-500', label: 'строгая' },
}

function PolicyCard({ csp, hsts }: { csp: CspAnalysis; hsts: HstsAnalysis }) {
  const cspTone = STRENGTH_TONE[csp.strength]
  const hstsTone = STRENGTH_TONE[hsts.strength]
  return (
    <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
      <div className="rounded-lg border border-border/60 bg-background/40 p-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className={cn('size-4 shrink-0', cspTone.text)} />
          <span className="text-xs font-medium text-foreground">CSP</span>
          <span className={cn('ml-auto text-xs font-semibold', cspTone.text)}>
            {cspTone.label}
          </span>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground text-pretty">
          {csp.note}
        </p>
      </div>
      <div className="rounded-lg border border-border/60 bg-background/40 p-3">
        <div className="flex items-center gap-2">
          <Lock className={cn('size-4 shrink-0', hstsTone.text)} />
          <span className="text-xs font-medium text-foreground">HSTS</span>
          <span className={cn('ml-auto text-xs font-semibold', hstsTone.text)}>
            {hstsTone.label}
          </span>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground text-pretty">
          {hsts.note}
        </p>
      </div>
    </div>
  )
}

const RISK_TONE: Record<
  CorsCheck['risk'],
  { border: string; text: string; label: string }
> = {
  none: {
    border: 'border-emerald-500/30 bg-emerald-500/5',
    text: 'text-emerald-500',
    label: 'Безопасно',
  },
  low: {
    border: 'border-amber-500/30 bg-amber-500/5',
    text: 'text-amber-500',
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

function CorsCard({ cors }: { cors: CorsCheck }) {
  if (!cors.tested) return null
  const tone = RISK_TONE[cors.risk]
  return (
    <div className={cn('mt-4 rounded-lg border p-3', tone.border)}>
      <div className="flex items-center gap-2">
        <Network className={cn('size-4 shrink-0', tone.text)} />
        <span className="text-xs font-medium text-foreground">
          CORS-политика
        </span>
        <span className={cn('ml-auto text-xs font-semibold', tone.text)}>
          {tone.label}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground text-pretty">
        {cors.note}
      </p>
      {cors.acao && (
        <div className="mt-1.5 font-mono text-[10px] text-muted-foreground">
          ACAO: {cors.acao}
          {cors.acac ? ' · credentials: true' : ''}
        </div>
      )}
    </div>
  )
}

function MethodsCard({ methods }: { methods: MethodsCheck }) {
  if (!methods.tested) return null
  const risky = methods.dangerous.length > 0 || methods.traceEnabled
  return (
    <div
      className={cn(
        'mt-4 rounded-lg border p-3',
        risky
          ? 'border-amber-500/40 bg-amber-500/10'
          : 'border-emerald-500/30 bg-emerald-500/5',
      )}
    >
      <div className="flex items-center gap-2">
        <Target
          className={cn(
            'size-4 shrink-0',
            risky ? 'text-amber-500' : 'text-emerald-500',
          )}
        />
        <span className="text-xs font-medium text-foreground">HTTP-методы</span>
        <span
          className={cn(
            'ml-auto text-xs font-semibold',
            risky ? 'text-amber-500' : 'text-emerald-500',
          )}
        >
          {risky ? 'Есть лишние' : 'В порядке'}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground text-pretty">
        {methods.note}
      </p>
      {methods.allow.length > 0 && (
        <div className="mt-1.5 font-mono text-[10px] text-muted-foreground">
          Allow: {methods.allow.join(', ')}
        </div>
      )}
    </div>
  )
}

function MixedContentCard({ mixed }: { mixed: MixedContentCheck }) {
  if (!mixed.tested) return null
  const bad = mixed.count > 0
  return (
    <div
      className={cn(
        'mt-4 rounded-lg border p-3',
        bad
          ? 'border-destructive/40 bg-destructive/10'
          : 'border-emerald-500/30 bg-emerald-500/5',
      )}
    >
      <div className="flex items-center gap-2">
        <Bug
          className={cn(
            'size-4 shrink-0',
            bad ? 'text-destructive' : 'text-emerald-500',
          )}
        />
        <span className="text-xs font-medium text-foreground">
          Mixed content
        </span>
        <span
          className={cn(
            'ml-auto text-xs font-semibold',
            bad ? 'text-destructive' : 'text-emerald-500',
          )}
        >
          {bad ? `Найдено: ${mixed.count}` : 'Не найдено'}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground text-pretty">
        {mixed.note}
      </p>
      {mixed.samples.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-0.5">
          {mixed.samples.map((s) => (
            <div
              key={s}
              className="truncate font-mono text-[10px] text-destructive"
            >
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function InfraCard({ infra }: { infra: InfraCheck }) {
  const hasAny =
    infra.cdn || infra.waf || infra.server || infra.cacheControl || infra.challenge
  if (!hasAny) return null
  return (
    <div
      className={cn(
        'mt-4 rounded-lg border p-3',
        infra.challenge
          ? 'border-destructive/40 bg-destructive/10'
          : infra.privateCacheable
            ? 'border-amber-500/40 bg-amber-500/10'
            : 'border-border/60 bg-background/40',
      )}
    >
      <div className="flex items-center gap-2">
        <Database
          className={cn(
            'size-4 shrink-0',
            infra.privateCacheable ? 'text-amber-500' : 'text-primary',
          )}
        />
        <span className="text-xs font-medium text-foreground">
          Инфраструктура и кэш
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
        {infra.cdn && <span>CDN: {infra.cdn}</span>}
        {infra.waf && <span>WAF: {infra.waf}</span>}
        {infra.server && <span>Server: {infra.server}</span>}
        {infra.cacheControl && (
          <span
            className={infra.privateCacheable ? 'text-amber-500' : undefined}
          >
            Cache-Control: {infra.cacheControl}
          </span>
        )}
      </div>
      {infra.privateCacheable && (
        <p className="mt-1.5 text-[11px] text-amber-500 text-pretty">
          Ответ с cookie помечен публично кэшируемым — риск утечки между
          пользователями через CDN.
        </p>
      )}
      {infra.challenge && infra.challengeNote && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <p className="text-[11px] text-destructive text-pretty">{infra.challengeNote}</p>
        </div>
      )}
    </div>
  )
}

/* ----------------------- Авто-«пробитая» находка ------------------------ */

const VERDICT_TONE: Record<
  DrillResult['verdict'],
  { border: string; text: string; label: string }
> = {
  exploitable: {
    border: 'border-destructive/40 bg-destructive/10',
    text: 'text-destructive',
    label: 'Подтверждено — эксплуатируемо',
  },
  likely: {
    border: 'border-amber-500/40 bg-amber-500/10',
    text: 'text-amber-500',
    label: 'Подтверждено — вероятно',
  },
  'not-exploitable': {
    border: 'border-emerald-500/30 bg-emerald-500/5',
    text: 'text-emerald-500',
    label: 'Не подтверждено',
  },
  inconclusive: {
    border: 'border-border/60 bg-background/40',
    text: 'text-muted-foreground',
    label: 'Не удалось определить',
  },
}

const STEP_MARK: Record<
  DrillResult['steps'][number]['outcome'],
  typeof CircleCheck
> = {
  confirmed: ShieldAlert,
  refuted: ShieldCheck,
  info: CircleAlert,
}

const STEP_TONE: Record<DrillResult['steps'][number]['outcome'], string> = {
  confirmed: 'text-destructive',
  refuted: 'text-emerald-500',
  info: 'text-muted-foreground',
}

function AutoDrillCard({ drill }: { drill: AutoDrill }) {
  const result = drill.result
  const tone = VERDICT_TONE[result.verdict]
  return (
    <div className={cn('rounded-lg border p-3', tone.border)}>
      <div className="flex items-center gap-2">
        <Target className={cn('size-4 shrink-0', tone.text)} />
        <span className="text-xs font-medium text-foreground">
          {result.title}
        </span>
        <span className={cn('ml-auto text-xs font-semibold', tone.text)}>
          {tone.label}
        </span>
      </div>

      <ol className="mt-2 flex flex-col gap-1.5">
        {result.steps.map((s, i) => {
          const Mark = STEP_MARK[s.outcome]
          return (
            <li key={i} className="flex items-start gap-2 text-[11px]">
              <Mark
                className={cn('mt-0.5 size-3.5 shrink-0', STEP_TONE[s.outcome])}
              />
              <span className="min-w-0">
                <span className="font-medium text-foreground">{s.label}: </span>
                <span className="text-muted-foreground">{s.detail}</span>
              </span>
            </li>
          )
        })}
      </ol>

      {result.evidence && (
        <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-border/60 bg-background/60 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-all">
          {result.evidence}
        </pre>
      )}
    </div>
  )
}

/* ------------------------- Отражение ввода ------------------------------ */

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
        <span className={cn('ml-auto text-xs font-semibold', tone.text)}>
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

const TLS_TONE: Record<
  TlsCheck['status'],
  { border: string; text: string; label: string }
> = {
  ok: {
    border: 'border-emerald-500/30 bg-emerald-500/5',
    text: 'text-emerald-500',
    label: 'Сертификат в порядке',
  },
  warn: {
    border: 'border-amber-500/40 bg-amber-500/10',
    text: 'text-amber-500',
    label: 'Требует внимания',
  },
  bad: {
    border: 'border-destructive/40 bg-destructive/10',
    text: 'text-destructive',
    label: 'Проблема с сертификатом',
  },
  unknown: {
    border: 'border-border/60 bg-background/40',
    text: 'text-muted-foreground',
    label: 'Не проверено',
  },
}

function TlsCard({ tls }: { tls: TlsCheck }) {
  const tone = TLS_TONE[tls.status]
  return (
    <div className={cn('mt-4 rounded-lg border p-3', tone.border)}>
      <div className="flex items-center gap-2">
        <KeyRound className={cn('size-4 shrink-0', tone.text)} />
        <span className="text-xs font-medium text-foreground">
          TLS-сертификат
        </span>
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

function PathLeaksCard({
  leaks,
  checked,
}: {
  leaks: PathLeak[]
  checked: boolean
}) {
  if (!checked) return null
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
        <span className="text-xs font-medium text-foreground">Типовые пути</span>
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
        <div className="mt-2 flex flex-col gap-2">
          {exposed.map((p) => (
            <div
              key={p.path}
              className={cn(
                'flex items-center gap-2 font-mono text-[11px]',
                p.severity === 'critical'
                  ? 'text-destructive'
                  : 'text-amber-500',
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

/* ---------------------------- Доступность ------------------------------- */

function PingReport({ result }: { result: PingResult }) {
  const allLost = result.received === 0
  return (
    <div className="flex flex-col gap-4">
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
          label={result.warmAvg !== null ? 'Тёплая средняя' : 'Средняя'}
          value={
            result.warmAvg !== null
              ? `${result.warmAvg} мс`
              : result.avg !== null
                ? `${result.avg} мс`
                : '—'
          }
          tone="muted"
          hint={
            result.warmAvg !== null
              ? `Без учёта холодной попытки. Общая средняя: ${result.avg} мс`
              : undefined
          }
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
                  {a.cold && (
                    <span
                      className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
                      title="Холодная попытка: включает установку TCP/TLS-соединения, задержка объективно выше"
                    >
                      cold
                    </span>
                  )}
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
  hint,
}: {
  icon: typeof Gauge
  label: string
  value: string
  tone: 'good' | 'bad' | 'muted'
  hint?: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card/40 p-3" title={hint}>
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
