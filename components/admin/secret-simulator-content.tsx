'use client'

/**
 * Content-pool editor for the client simulator.
 *
 * Lets the operator edit every piece of language the simulator generates, so
 * the bots always sound like the real brand and platform:
 *   • Web-form opener config: site name, vacancies (title + salary), cities,
 *     work-schedule labels, match-% range.
 *   • Persona-trait pools: archetypes, tempers, occupations, motivations,
 *     life details, verbal quirks, persona goals, opener templates.
 *
 * All changes are persisted to sim_settings.content_config (migration 080).
 * Missing / empty fields fall back to the hardcoded defaults in data.ts so
 * existing deployments keep working without running the migration.
 */

import { useCallback, useEffect, useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  FilePen,
  Loader2,
  Plus,
  RefreshCcw,
  Save,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { SimContentConfig, SimStatus } from '@/lib/client-sim/types'
import { SIM_CONTENT_DEFAULTS } from '@/lib/client-sim/generate'
import {
  simStatusAction,
  simUpdateContentConfigAction,
} from '@/app/actions/client-sim'

/* =====================================================================
 * Helpers
 * ===================================================================== */

/** Split a newline-separated textarea into a trimmed, non-empty array. */
function splitLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Join an array into a newline-separated textarea value. */
function joinLines(arr: string[]): string {
  return arr.join('\n')
}

/* =====================================================================
 * Tiny sub-components
 * ===================================================================== */

interface SectionHeaderProps {
  label: string
  open: boolean
  onToggle: () => void
}

function SectionHeader({ label, open, onToggle }: SectionHeaderProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm font-medium hover:bg-muted/60 transition-colors"
    >
      <span>{label}</span>
      {open ? (
        <ChevronUp className="size-4 text-muted-foreground" />
      ) : (
        <ChevronDown className="size-4 text-muted-foreground" />
      )}
    </button>
  )
}

/* =====================================================================
 * Vacancy editor sub-component
 * ===================================================================== */

interface Vacancy {
  title: string
  salary: string
}

interface VacancyEditorProps {
  value: Vacancy[]
  onChange: (v: Vacancy[]) => void
}

function VacancyEditor({ value, onChange }: VacancyEditorProps) {
  function handleChange(idx: number, field: keyof Vacancy, val: string) {
    onChange(value.map((v, i) => (i === idx ? { ...v, [field]: val } : v)))
  }
  function add() {
    onChange([...value, { title: '', salary: '' }])
  }
  function remove(idx: number) {
    onChange(value.filter((_, i) => i !== idx))
  }
  return (
    <div className="flex flex-col gap-2">
      {value.map((v, i) => (
        <div key={i} className="flex gap-2 items-start">
          <Input
            placeholder="Должность"
            value={v.title}
            onChange={(e) => handleChange(i, 'title', e.target.value)}
            className="flex-1 h-8 text-xs"
          />
          <Input
            placeholder="Зарплата"
            value={v.salary}
            onChange={(e) => handleChange(i, 'salary', e.target.value)}
            className="w-36 h-8 text-xs"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => remove(i)}
            title="Удалить"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 text-xs w-full"
        onClick={add}
      >
        <Plus className="size-3.5 mr-1" />
        Добавить вакансию
      </Button>
    </div>
  )
}

/* =====================================================================
 * PoolTextarea — textarea editor for a simple string pool
 * ===================================================================== */

interface PoolTextareaProps {
  label: string
  placeholder: string
  value: string[]
  onChange: (v: string[]) => void
  rows?: number
}

function PoolTextarea({ label, placeholder, value, onChange, rows = 8 }: PoolTextareaProps) {
  const [raw, setRaw] = useState(() => joinLines(value))

  // Sync outward on blur so we don't thrash the parent on every keystroke.
  function handleBlur() {
    onChange(splitLines(raw))
  }

  // Keep in sync when value changes from outside (e.g. reset).
  useEffect(() => {
    setRaw(joinLines(value))
  }, [value])

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Textarea
        rows={rows}
        placeholder={placeholder}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={handleBlur}
        className="text-xs font-mono resize-y min-h-0"
      />
      <p className="text-xs text-muted-foreground">
        {splitLines(raw).length} элементов · по одному на строку
      </p>
    </div>
  )
}

/* =====================================================================
 * Top-level state shape
 * ===================================================================== */

interface ContentForm {
  // Opener tab
  siteName: string
  vacancies: Vacancy[]
  cities: string[]
  scheduleTypes: string[]
  matchPctMin: number
  matchPctMax: number
  // Persona tab — name pools
  maleFirstNames: string[]
  femaleFirstNames: string[]
  lastNames: string[]
  // Persona tab — trait pools
  tempers: string[]
  occupations: string[]
  motivations: string[]
  lifeDetails: string[]
  quirks: string[]
  goals: string[]
  openerTemplates: string[]
  emojiPictures: string[]
}

function formToConfig(f: ContentForm): SimContentConfig {
  return {
    siteName: f.siteName || undefined,
    vacancies: f.vacancies.filter((v) => v.title.trim()),
    cities: f.cities,
    scheduleTypes: f.scheduleTypes,
    matchPctMin: f.matchPctMin,
    matchPctMax: f.matchPctMax,
    persona: {
      maleFirstNames: f.maleFirstNames,
      femaleFirstNames: f.femaleFirstNames,
      lastNames: f.lastNames,
      tempers: f.tempers,
      occupations: f.occupations,
      motivations: f.motivations,
      lifeDetails: f.lifeDetails,
      quirks: f.quirks,
      goals: f.goals,
      openerTemplates: f.openerTemplates,
      emojiPictures: f.emojiPictures,
    },
  }
}

function configToForm(cfg: SimContentConfig | null): ContentForm {
  const d = SIM_CONTENT_DEFAULTS
  return {
    siteName: cfg?.siteName ?? d.siteName,
    vacancies: (cfg?.vacancies && cfg.vacancies.length > 0) ? cfg.vacancies : d.vacancies,
    cities: (cfg?.cities && cfg.cities.length > 0) ? cfg.cities : d.cities,
    scheduleTypes: (cfg?.scheduleTypes && cfg.scheduleTypes.length > 0) ? cfg.scheduleTypes : d.scheduleTypes,
    matchPctMin: cfg?.matchPctMin ?? d.matchPctMin,
    matchPctMax: cfg?.matchPctMax ?? d.matchPctMax,
    maleFirstNames: cfg?.persona?.maleFirstNames ?? [],
    femaleFirstNames: cfg?.persona?.femaleFirstNames ?? [],
    lastNames: cfg?.persona?.lastNames ?? [],
    tempers: cfg?.persona?.tempers ?? [],
    occupations: cfg?.persona?.occupations ?? [],
    motivations: cfg?.persona?.motivations ?? [],
    lifeDetails: cfg?.persona?.lifeDetails ?? [],
    quirks: cfg?.persona?.quirks ?? [],
    goals: cfg?.persona?.goals ?? [],
    openerTemplates: cfg?.persona?.openerTemplates ?? [],
    emojiPictures: cfg?.persona?.emojiPictures ?? [],
  }
}

/* =====================================================================
 * Main component
 * ===================================================================== */

export function SecretSimulatorContent() {
  const [status, setStatus] = useState<SimStatus | null>(null)
  const [form, setForm] = useState<ContentForm>(() => configToForm(null))
  const [saving, startSave] = useTransition()
  const [resetting, startReset] = useTransition()

  // Section open/close state — all closed by default to save vertical space.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({})
  function toggleSection(key: string) {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  // ---- Load current config ----
  const load = useCallback(async () => {
    try {
      const s = await simStatusAction()
      setStatus(s)
      setForm(configToForm(s.contentConfig))
    } catch {
      toast.error('Не удалось загрузить конфигурацию контента')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // ---- Helpers to update a single field ----
  function setField<K extends keyof ContentForm>(key: K, val: ContentForm[K]) {
    setForm((f) => ({ ...f, [key]: val }))
  }

  // ---- Save ----
  function handleSave() {
    startSave(async () => {
      try {
        const next = await simUpdateContentConfigAction(formToConfig(form))
        setStatus(next)
        setForm(configToForm(next.contentConfig))
        toast.success('Контент сохранён')
      } catch (err) {
        toast.error(`Ошибка сохранения: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }

  // ---- Reset to defaults ----
  function handleReset() {
    startReset(async () => {
      try {
        const next = await simUpdateContentConfigAction(null)
        setStatus(next)
        setForm(configToForm(null))
        toast.success('Контент сброшен до значений по умолчанию')
      } catch (err) {
        toast.error(`Ошибка сброса: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }

  const busy = saving || resetting

  return (
    <div className="flex flex-col gap-4">
      {/* ---- Header ---- */}
      <Card className="p-4 flex items-start gap-3">
        <FilePen className="size-5 shrink-0 mt-0.5 text-primary" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Редактор контента симулятора</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Замените любые пулы данных (вакансии, города, черты характера…), чтобы боты
            всегда звучали как ваш бренд. Пустые или не заполненные поля возвращаются
            к встроенным значениям по умолчанию.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={busy}
            className="h-8 text-xs"
          >
            {resetting ? (
              <Loader2 className="size-3.5 mr-1 animate-spin" />
            ) : (
              <RefreshCcw className="size-3.5 mr-1" />
            )}
            Сбросить
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={busy}
            className="h-8 text-xs"
          >
            {saving ? (
              <Loader2 className="size-3.5 mr-1 animate-spin" />
            ) : (
              <Save className="size-3.5 mr-1" />
            )}
            Сохранить
          </Button>
        </div>
      </Card>

      {/* ---- Tabs: Opener / Persona ---- */}
      <Tabs defaultValue="opener" className="w-full">
        <TabsList className="w-full">
          <TabsTrigger value="opener" className="flex-1 text-xs">
            Вступительное сообщение
          </TabsTrigger>
          <TabsTrigger value="persona" className="flex-1 text-xs">
            Личность персонажа
          </TabsTrigger>
        </TabsList>

        {/* ==================== OPENER TAB ==================== */}
        <TabsContent value="opener" className="mt-4 flex flex-col gap-4">
          {/* Site name */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Название сайта / платформы</Label>
            <Input
              value={form.siteName}
              onChange={(e) => setField('siteName', e.target.value)}
              placeholder="Thunders Group"
              className="h-8 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Подставляется в шаблон: «Я прошёл ИИ-подбор на сайте <strong>{form.siteName || 'Thunders Group'}</strong>»
            </p>
          </div>

          {/* Match % range */}
          <div className="flex gap-4">
            <div className="flex-1 flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Совпадение от, %</Label>
              <Input
                type="number"
                min={50}
                max={99}
                value={form.matchPctMin}
                onChange={(e) => setField('matchPctMin', Number(e.target.value))}
                className="h-8 text-sm"
              />
            </div>
            <div className="flex-1 flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Совпадение до, %</Label>
              <Input
                type="number"
                min={51}
                max={100}
                value={form.matchPctMax}
                onChange={(e) => setField('matchPctMax', Number(e.target.value))}
                className="h-8 text-sm"
              />
            </div>
          </div>

          {/* Vacancies */}
          <div className="flex flex-col gap-2">
            <SectionHeader
              label={`Вакансии (${form.vacancies.length})`}
              open={openSections['vacancies'] ?? true}
              onToggle={() => toggleSection('vacancies')}
            />
            {(openSections['vacancies'] ?? true) && (
              <VacancyEditor
                value={form.vacancies}
                onChange={(v) => setField('vacancies', v)}
              />
            )}
          </div>

          {/* Cities */}
          <div className="flex flex-col gap-2">
            <SectionHeader
              label={`Города (${form.cities.length})`}
              open={openSections['cities'] ?? false}
              onToggle={() => toggleSection('cities')}
            />
            {(openSections['cities'] ?? false) && (
              <PoolTextarea
                label="Список городов"
                placeholder="Москва&#10;Санкт-Петербург&#10;Екатеринбург"
                value={form.cities}
                onChange={(v) => setField('cities', v)}
                rows={6}
              />
            )}
          </div>

          {/* Schedule types */}
          <div className="flex flex-col gap-2">
            <SectionHeader
              label={`Типы графика (${form.scheduleTypes.length})`}
              open={openSections['scheduleTypes'] ?? false}
              onToggle={() => toggleSection('scheduleTypes')}
            />
            {(openSections['scheduleTypes'] ?? false) && (
              <PoolTextarea
                label="Типы графика"
                placeholder="Удалённо&#10;Полный день&#10;Сменный график"
                value={form.scheduleTypes}
                onChange={(v) => setField('scheduleTypes', v)}
                rows={4}
              />
            )}
          </div>
        </TabsContent>

        {/* ==================== PERSONA TAB ==================== */}
        <TabsContent value="persona" className="mt-4 flex flex-col gap-4">
          <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <AlertCircle className="size-3.5 shrink-0" />
            Пустые пулы автоматически заменяются встроенными значениями (~100+ элементов каждый).
            Заполняйте только те пулы, которые хотите переопределить.
          </div>

          {(
            [
              {
                key: 'maleFirstNames',
                label: 'Мужские имена',
                placeholder: 'Александр\nДмитрий\nМаксим',
                rows: 6,
              },
              {
                key: 'femaleFirstNames',
                label: 'Женские имена',
                placeholder: 'Анна\nМария\nОльга',
                rows: 6,
              },
              {
                key: 'lastNames',
                label: 'Фамилии',
                placeholder: 'Иванов\nСмирнов\nКузнецов',
                rows: 6,
              },
              {
                key: 'tempers',
                label: 'Черты характера',
                placeholder: 'нетерпеливый\nподозрительный\nнаглый',
                rows: 6,
              },
              {
                key: 'occupations',
                label: 'Профессии / занятия',
                placeholder: 'работает на стройке\nтаксует\nгрузчик на складе',
                rows: 6,
              },
              {
                key: 'motivations',
                label: 'Мотивации (почему ищет работу)',
                placeholder: 'нужны деньги на кредит\nкопит на отпуск',
                rows: 5,
              },
              {
                key: 'lifeDetails',
                label: 'Жизненные детали',
                placeholder: 'двое детей\nипотека\nживёт с родителями',
                rows: 5,
              },
              {
                key: 'quirks',
                label: 'Слова-паразиты',
                placeholder: 'короче\nну это самое\nтипа\nблин',
                rows: 4,
              },
              {
                key: 'goals',
                label: 'Скрытые цели',
                placeholder: 'понять, сколько реально можно заработать, и согласиться…',
                rows: 5,
              },
              {
                key: 'openerTemplates',
                label: 'Шаблоны приветствий (LLM-путь)',
                placeholder: 'здравствуйте нашёл у вас {hook} ещё актуально\nпривет по поводу {hook} можно узнать',
                rows: 6,
              },
              {
                key: 'emojiPictures',
                label: 'Эмодзи-аватары',
                placeholder: '🧔\n👩\n👴\n👩‍🦱',
                rows: 4,
              },
            ] as const
          ).map(({ key, label, placeholder, rows }) => (
            <div key={key} className="flex flex-col gap-2">
              <SectionHeader
                label={`${label} (${(form[key as keyof ContentForm] as string[]).length || 'по умолчанию'})`}
                open={openSections[key] ?? false}
                onToggle={() => toggleSection(key)}
              />
              {(openSections[key] ?? false) && (
                <PoolTextarea
                  label={label}
                  placeholder={placeholder}
                  value={form[key as keyof ContentForm] as string[]}
                  onChange={(v) => setField(key as keyof ContentForm, v as ContentForm[typeof key])}
                  rows={rows}
                />
              )}
            </div>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  )
}
