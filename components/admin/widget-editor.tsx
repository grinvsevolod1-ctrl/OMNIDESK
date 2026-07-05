'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Clock,
  Loader2,
  MessageSquare,
  Monitor,
  MousePointerClick,
  Palette,
  Plus,
  Send,
  Smartphone,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { updateLivechatWidgetConfigAction } from '@/app/actions/livechat'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type {
  LivechatWidgetConfig,
  WidgetMessenger,
  WidgetMessengerType,
} from '@/lib/widget-config'

const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: 'Пн' },
  { value: 2, label: 'Вт' },
  { value: 3, label: 'Ср' },
  { value: 4, label: 'Чт' },
  { value: 5, label: 'Пт' },
  { value: 6, label: 'Сб' },
  { value: 0, label: 'Вс' },
]

const TIMEZONES = [
  'Europe/Moscow',
  'Europe/Kaliningrad',
  'Europe/Samara',
  'Asia/Yekaterinburg',
  'Asia/Omsk',
  'Asia/Krasnoyarsk',
  'Asia/Irkutsk',
  'Asia/Vladivostok',
  'Europe/Kyiv',
  'Europe/London',
  'UTC',
]

const HEX_RE = /^#[0-9a-fA-F]{6}$/

/**
 * Load an image file, center-crop it to a square, downscale to `size` px, and
 * return a compact JPEG data URL. Keeps stored avatars tiny and self-contained.
 */
function downscaleImage(file: File, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('no canvas context'))
        return
      }
      const side = Math.min(img.width, img.height)
      const sx = (img.width - side) / 2
      const sy = (img.height - side) / 2
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image load failed'))
    }
    img.src = url
  })
}

/** Deep clone so editing never mutates the prop coming from the server. */
function cloneConfig(c: LivechatWidgetConfig): LivechatWidgetConfig {
  return JSON.parse(JSON.stringify(c))
}

function timeValue(h: number, m: number): string {
  const hh = String(h).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  return `${hh}:${mm}`
}

function parseTime(v: string): { h: number; m: number } {
  const [h, m] = v.split(':').map((x) => Number.parseInt(x, 10))
  return {
    h: Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 0,
    m: Number.isFinite(m) ? Math.min(59, Math.max(0, m)) : 0,
  }
}

/**
 * Visual widget editor: a wide dialog with editing controls on the left and a
 * live iframe preview on the right that renders the REAL widget in preview
 * mode. Every change is pushed to the iframe via postMessage, so the admin
 * sees exactly what visitors will see. Saving persists the full config and the
 * live site picks it up on its next config poll (~15s).
 */
export function WidgetEditor({
  channelId,
  channelName,
  domain,
  initialConfig,
  base,
}: {
  channelId: string
  channelName: string
  domain: string
  initialConfig: LivechatWidgetConfig
  base: string
}) {
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<LivechatWidgetConfig>(() =>
    cloneConfig(initialConfig),
  )
  const [previewOff, setPreviewOff] = useState(false)
  const [pending, setPending] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const readyRef = useRef(false)

  // Reset to the saved config whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setConfig(cloneConfig(initialConfig))
      setPreviewOff(false)
      readyRef.current = false
    }
  }, [open, initialConfig])

  // The preview document loads the real widget script in preview mode.
  const srcDoc = useMemo(() => {
    const src = `${base}/livechat.js`
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:#eef2f7;
        background-image:radial-gradient(circle at 1px 1px, rgba(15,23,42,.08) 1px, transparent 0);
        background-size:22px 22px;overflow:hidden}
    </style></head><body>
      <script async src="${src}" data-omnidesk-preview="1"></script>
    </body></html>`
  }, [base])

  const pushToPreview = useCallback(() => {
    const win = iframeRef.current?.contentWindow
    if (!win || !readyRef.current) return
    win.postMessage({ type: 'omnidesk:config', config }, '*')
    win.postMessage({ type: 'omnidesk:offhours', offHours: previewOff }, '*')
  }, [config, previewOff])

  // Listen for the iframe's "ready" handshake, then start pushing config.
  useEffect(() => {
    if (!open) return
    function onMessage(ev: MessageEvent) {
      if (ev.data && ev.data.type === 'omnidesk:ready') {
        readyRef.current = true
        pushToPreview()
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [open, pushToPreview])

  // Re-push whenever the config or the off-hours preview toggle changes.
  useEffect(() => {
    pushToPreview()
  }, [pushToPreview])

  function patch(updater: (draft: LivechatWidgetConfig) => void) {
    setConfig((prev) => {
      const next = cloneConfig(prev)
      updater(next)
      return next
    })
  }

  function save() {
    setPending(true)
    updateLivechatWidgetConfigAction(channelId, config)
      .then((res) => {
        if (res.ok) {
          toast.success(res.message)
          setOpen(false)
        } else {
          toast.error(res.message)
        }
      })
      .finally(() => setPending(false))
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs">
            <Palette className="size-3.5" />
            Настроить чат
          </Button>
        }
      />
      <DialogContent className="flex max-h-[92vh] w-[min(1100px,96vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1100px,96vw)]">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>Конструктор чата — {channelName}</DialogTitle>
          <DialogDescription>
            Настройте виджет для {domain || 'сайта'}. Превью справа — это
            реальный чат. Изменения появятся на сайте в течение ~15 секунд после
            сохранения.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_420px]">
          {/* Left: editing controls */}
          <div className="min-h-0 overflow-y-auto border-r border-border p-5">
            <EditorTabs config={config} patch={patch} />
          </div>

          {/* Right: live preview */}
          <div className="flex min-h-0 flex-col bg-muted/30">
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Monitor className="size-3.5" />
                Живое превью
              </span>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                Режим «нерабочее время»
                <Switch
                  checked={previewOff}
                  onCheckedChange={(v) => setPreviewOff(Boolean(v))}
                  size="sm"
                />
              </label>
            </div>
            <div className="relative min-h-[480px] flex-1">
              <iframe
                ref={iframeRef}
                title="Превью виджета чата"
                srcDoc={srcDoc}
                className="absolute inset-0 size-full border-0"
                sandbox="allow-scripts"
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Отмена
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Сохранить
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function EditorTabs({
  config,
  patch,
}: {
  config: LivechatWidgetConfig
  patch: (updater: (draft: LivechatWidgetConfig) => void) => void
}) {
  return (
    <Tabs defaultValue="appearance" className="gap-4">
      <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-muted/60">
        <TabsTrigger value="appearance" className="flex-none gap-1.5 px-2.5">
          <Palette className="size-3.5" />
          Вид
        </TabsTrigger>
        <TabsTrigger value="content" className="flex-none gap-1.5 px-2.5">
          <MessageSquare className="size-3.5" />
          Контент
        </TabsTrigger>
        <TabsTrigger value="messengers" className="flex-none gap-1.5 px-2.5">
          <Send className="size-3.5" />
          Мессенджеры
        </TabsTrigger>
        <TabsTrigger value="hours" className="flex-none gap-1.5 px-2.5">
          <Clock className="size-3.5" />
          Часы
        </TabsTrigger>
        <TabsTrigger value="behavior" className="flex-none gap-1.5 px-2.5">
          <MousePointerClick className="size-3.5" />
          Поведение
        </TabsTrigger>
      </TabsList>

      <TabsContent value="appearance">
        <AppearanceTab config={config} patch={patch} />
      </TabsContent>
      <TabsContent value="content">
        <ContentTab config={config} patch={patch} />
      </TabsContent>
      <TabsContent value="messengers">
        <MessengersTab config={config} patch={patch} />
      </TabsContent>
      <TabsContent value="hours">
        <HoursTab config={config} patch={patch} />
      </TabsContent>
      <TabsContent value="behavior">
        <BehaviorTab config={config} patch={patch} />
      </TabsContent>
    </Tabs>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

type TabProps = {
  config: LivechatWidgetConfig
  patch: (updater: (draft: LivechatWidgetConfig) => void) => void
}

function AppearanceTab({ config, patch }: TabProps) {
  const a = config.appearance
  const color = HEX_RE.test(a.color) ? a.color : '#2563eb'
  const avatarInputRef = useRef<HTMLInputElement>(null)

  // Read an uploaded image, downscale it to a small square via <canvas>, and
  // store the result as a data URL directly in the config. This keeps avatars
  // self-contained (no external hosting / blob storage needed) while bounding
  // the stored size so the JSON config stays small.
  async function onAvatarFile(file: File | undefined | null) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('Загрузите изображение.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Файл слишком большой (макс. 5 МБ).')
      return
    }
    try {
      const dataUrl = await downscaleImage(file, 160)
      patch((d) => void (d.appearance.agentAvatar = dataUrl))
    } catch {
      toast.error('Не удалось обработать изображение.')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label="Заголовок шапки">
        <Input
          value={a.title}
          onChange={(e) => patch((d) => void (d.appearance.title = e.target.value))}
          placeholder="Чат поддержки"
        />
      </Field>
      <Field label="Подзаголовок" hint="Короткая строка под заголовком.">
        <Input
          value={a.subtitle}
          onChange={(e) =>
            patch((d) => void (d.appearance.subtitle = e.target.value))
          }
          placeholder="Обычно отвечаем за 5 минут"
        />
      </Field>
      <Field label="Имя агента" hint="Показывается рядом с аватаром.">
        <Input
          value={a.agentName}
          onChange={(e) =>
            patch((d) => void (d.appearance.agentName = e.target.value))
          }
          placeholder="Анна"
        />
      </Field>
      <Field label="Аватар агента" hint="Загрузите картинку. Пусто — иконка.">
        <div className="flex items-center gap-3">
          <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted">
            {a.agentAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={a.agentAvatar || '/placeholder.svg'}
                alt="Аватар агента"
                className="size-full object-cover"
              />
            ) : (
              <MessageSquare className="size-5 text-muted-foreground" />
            )}
          </div>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              void onAvatarFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => avatarInputRef.current?.click()}
          >
            <Upload className="size-4" />
            {a.agentAvatar ? 'Заменить' : 'Загрузить'}
          </Button>
          {a.agentAvatar ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                patch((d) => void (d.appearance.agentAvatar = ''))
              }
            >
              <X className="size-4" />
              Удалить
            </Button>
          ) : null}
        </div>
      </Field>
      <Field label="Фирменный цвет">
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={color}
            onChange={(e) =>
              patch((d) => void (d.appearance.color = e.target.value))
            }
            className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-border bg-background p-1"
            aria-label="Выбор фирменного цвета"
          />
          <Input
            value={a.color}
            onChange={(e) =>
              patch((d) => void (d.appearance.color = e.target.value))
            }
            placeholder="#2563eb"
            className="font-mono"
          />
        </div>
      </Field>
      <Field label="Сторона на странице">
        <Select
          value={a.position}
          onValueChange={(v) =>
            patch((d) => void (d.appearance.position = v === 'left' ? 'left' : 'right'))
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="right">Справа</SelectItem>
            <SelectItem value="left">Слева</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <div className="rounded-lg border border-border p-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          Приветственное облачко над кнопкой
        </p>
        <div className="flex flex-col gap-3">
          <Field label="Текст облачка" hint="Пусто — облачко не показывается.">
            <Input
              value={a.greeting}
              onChange={(e) =>
                patch((d) => void (d.appearance.greeting = e.target.value))
              }
              placeholder="Здравствуйте! Чем помочь?"
            />
          </Field>
          <Field label="Вторая строка облачка">
            <Input
              value={a.greetingSub}
              onChange={(e) =>
                patch((d) => void (d.appearance.greetingSub = e.target.value))
              }
              placeholder="Нажмите, чтобы начать"
            />
          </Field>
        </div>
      </div>
    </div>
  )
}

function ContentTab({ config, patch }: TabProps) {
  const c = config.content
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Приветственное сообщение"
        hint="Бабл от агента при открытии чата, чтобы он не был пустым."
      >
        <Textarea
          value={c.welcomeMessage}
          onChange={(e) =>
            patch((d) => void (d.content.welcomeMessage = e.target.value))
          }
          placeholder="Здравствуйте! Чем можем помочь?"
          rows={3}
        />
      </Field>

      <Field
        label="Быстрые ответы"
        hint="Чипы-подсказки под приветствием. По клику подставляются в поле."
      >
        <QuickReplyEditor
          items={c.quickReplies}
          onChange={(items) =>
            patch((d) => void (d.content.quickReplies = items))
          }
        />
      </Field>

      <Field label="Плейсхолдер поля ввода">
        <Input
          value={c.inputPlaceholder}
          onChange={(e) =>
            patch((d) => void (d.content.inputPlaceholder = e.target.value))
          }
          placeholder="Введите сообщение..."
        />
      </Field>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-medium">Мессенджеры в рабочее время</p>
          <p className="text-xs text-muted-foreground">
            Показывать кнопки мессенджеров прямо в чате, а не только офлайн.
          </p>
        </div>
        <Switch
          checked={c.showMessengers}
          onCheckedChange={(v) =>
            patch((d) => void (d.content.showMessengers = Boolean(v)))
          }
        />
      </div>

      {c.showMessengers ? (
        <Field label="Заголовок над кнопками мессенджеров">
          <Input
            value={c.messengersTitle}
            onChange={(e) =>
              patch((d) => void (d.content.messengersTitle = e.target.value))
            }
            placeholder="Или напишите в мессенджер"
          />
        </Field>
      ) : null}
    </div>
  )
}

function QuickReplyEditor({
  items,
  onChange,
}: {
  items: string[]
  onChange: (items: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  function add() {
    const v = draft.trim()
    if (!v || items.length >= 6) return
    onChange([...items, v])
    setDraft('')
  }
  return (
    <div className="flex flex-col gap-2">
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it, i) => (
            <span
              key={`${it}-${i}`}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 py-1 pl-2.5 pr-1 text-xs"
            >
              {it}
              <button
                type="button"
                onClick={() => onChange(items.filter((_, idx) => idx !== i))}
                className="flex size-4 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={`Удалить «${it}»`}
              >
                <Trash2 className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {items.length < 6 ? (
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            placeholder="Например: Узнать цены"
          />
          <Button type="button" variant="outline" size="icon" onClick={add}>
            <Plus className="size-4" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function MessengersTab({ config, patch }: TabProps) {
  function update(i: number, next: Partial<WidgetMessenger>) {
    patch((d) => {
      d.messengers[i] = { ...d.messengers[i], ...next }
    })
  }
  function add() {
    patch((d) => {
      if (d.messengers.length >= 8) return
      d.messengers.push({ type: 'telegram', label: 'Telegram', value: '' })
    })
  }
  function remove(i: number) {
    patch((d) => {
      d.messengers.splice(i, 1)
    })
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Кнопки мессенджеров показываются в нерабочее время и, если включено, в
        рабочее. Для WhatsApp укажите номер телефона, для Telegram/произвольной —
        полную ссылку.
      </p>
      {config.messengers.map((m, i) => (
        <div
          key={i}
          className="flex flex-col gap-2 rounded-lg border border-border p-3"
        >
          <div className="flex items-center gap-2">
            <Select
              value={m.type}
              onValueChange={(v) =>
                update(i, { type: v as WidgetMessengerType })
              }
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="telegram">Telegram</SelectItem>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
                <SelectItem value="custom">Другое</SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={m.label}
              onChange={(e) => update(i, { label: e.target.value })}
              placeholder="Подпись кнопки"
              className="flex-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => remove(i)}
              aria-label="Удалить мессенджер"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
          <Input
            value={m.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder={
              m.type === 'whatsapp'
                ? '+7 999 123-45-67'
                : m.type === 'telegram'
                  ? 'https://t.me/username'
                  : 'https://…'
            }
          />
        </div>
      ))}
      {config.messengers.length < 8 ? (
        <Button type="button" variant="outline" onClick={add} className="gap-1.5">
          <Plus className="size-4" />
          Добавить мессенджер
        </Button>
      ) : null}
    </div>
  )
}

function HoursTab({ config, patch }: TabProps) {
  const wh = config.workingHours
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-medium">Учитывать часы работы</p>
          <p className="text-xs text-muted-foreground">
            Вне этих часов показывается экран «нерабочее время» с мессенджерами.
          </p>
        </div>
        <Switch
          checked={wh.enabled}
          onCheckedChange={(v) =>
            patch((d) => void (d.workingHours.enabled = Boolean(v)))
          }
        />
      </div>

      {wh.enabled ? (
        <>
          <Field label="Часовой пояс">
            <Select
              value={wh.tz}
              onValueChange={(v) =>
                patch((d) => void (d.workingHours.tz = v ?? d.workingHours.tz))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Начало">
              <Input
                type="time"
                value={timeValue(wh.startHour, wh.startMinute)}
                onChange={(e) => {
                  const { h, m } = parseTime(e.target.value)
                  patch((d) => {
                    d.workingHours.startHour = h
                    d.workingHours.startMinute = m
                  })
                }}
              />
            </Field>
            <Field label="Конец">
              <Input
                type="time"
                value={timeValue(wh.endHour, wh.endMinute)}
                onChange={(e) => {
                  const { h, m } = parseTime(e.target.value)
                  patch((d) => {
                    d.workingHours.endHour = h
                    d.workingHours.endMinute = m
                  })
                }}
              />
            </Field>
          </div>

          <Field
            label="Рабочие дни"
            hint="Если конец раньше начала — окно считается ночным (через полночь)."
          >
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((d) => {
                const active = wh.days.includes(d.value)
                return (
                  <button
                    key={d.value}
                    type="button"
                    onClick={() =>
                      patch((draft) => {
                        const set = new Set(draft.workingHours.days)
                        set.has(d.value)
                          ? set.delete(d.value)
                          : set.add(d.value)
                        draft.workingHours.days = Array.from(set).sort(
                          (a, b) => a - b,
                        )
                      })
                    }
                    className={cn(
                      'flex size-9 items-center justify-center rounded-md border text-xs font-medium transition-colors',
                      active
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {d.label}
                  </button>
                )
              })}
            </div>
          </Field>

          <div className="rounded-lg border border-border p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Экран «нерабочее время»
            </p>
            <div className="flex flex-col gap-3">
              <Field label="Заголовок">
                <Input
                  value={config.offline.title}
                  onChange={(e) =>
                    patch((d) => void (d.offline.title = e.target.value))
                  }
                  placeholder="Мы сейчас не работаем"
                />
              </Field>
              <Field label="Текст">
                <Textarea
                  value={config.offline.text}
                  onChange={(e) =>
                    patch((d) => void (d.offline.text = e.target.value))
                  }
                  rows={3}
                  placeholder="Оставьте сообщение или напишите в мессенджер."
                />
              </Field>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

function BehaviorTab({ config, patch }: TabProps) {
  const ao = config.autoOpen
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-medium">Авто-открытие чата</p>
          <p className="text-xs text-muted-foreground">
            Автоматически разворачивать окно через заданное время после загрузки
            страницы.
          </p>
        </div>
        <Switch
          checked={ao.enabled}
          onCheckedChange={(v) =>
            patch((d) => void (d.autoOpen.enabled = Boolean(v)))
          }
        />
      </div>
      {ao.enabled ? (
        <Field label="Задержка перед открытием (секунды)">
          <Input
            type="number"
            min={1}
            max={600}
            value={ao.delaySec}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10)
              patch(
                (d) =>
                  void (d.autoOpen.delaySec = Number.isFinite(n)
                    ? Math.min(600, Math.max(1, n))
                    : 15),
              )
            }}
          />
        </Field>
      ) : null}

      <div className="flex items-start gap-2 rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
        <Smartphone className="mt-0.5 size-4 shrink-0" />
        <span>
          Авто-открытие срабатывает один раз за сессию и только в рабочее время.
          В превью оно отключено, чтобы не мешать настройке.
        </span>
      </div>
    </div>
  )
}
