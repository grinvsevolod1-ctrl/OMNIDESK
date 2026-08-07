'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Clock,
  Loader2,
  MessageSquare,
  Monitor,
  MousePointerClick,
  Palette,
  Send,
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
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { LivechatWidgetConfig } from '@/lib/widget-config'

function cloneConfig(c: LivechatWidgetConfig): LivechatWidgetConfig {
  return JSON.parse(JSON.stringify(c))
}


import {
  AppearanceTab,
  BehaviorTab,
  ContentTab,
  HoursTab,
  MessengersTab,
} from '@/components/admin/widget-editor-tabs'

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
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
      <TabsList className="flex !h-auto w-full flex-wrap justify-start gap-1 bg-muted/60">
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

