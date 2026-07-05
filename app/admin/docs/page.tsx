import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Code2,
  Globe,
  MessageCircle,
  Plug,
  Radio,
  ShieldCheck,
  Users,
} from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { DocCodeBlock } from '@/components/admin/doc-code-block'
import { PageHeader } from '@/components/page-parts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

/** Публичный домен панели — сниппеты и эндпоинты подставляются автоматически. */
const PANEL_DOMAIN = 'charter-panel.com'
const PANEL_URL = `https://${PANEL_DOMAIN}`

export const metadata = {
  title: 'Документация — Charter Panel',
  description:
    'Как установить, настроить и использовать виджет онлайн-чата Charter Panel.',
}

function Section({
  id,
  icon: Icon,
  title,
  description,
  children,
}: {
  id: string
  icon: typeof BookOpen
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <Card id={id} className="scroll-mt-6 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-4 space-y-4 text-sm leading-relaxed text-foreground">
        {children}
      </div>
    </Card>
  )
}

function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-2.5 last:border-0 sm:flex-row sm:gap-4">
      <span className="w-44 shrink-0 font-mono text-[13px] text-foreground">
        {name}
      </span>
      <span className="text-sm text-muted-foreground">{children}</span>
    </div>
  )
}

function StatusPill({
  tone,
  label,
}: {
  tone: 'amber' | 'emerald' | 'muted' | 'red'
  label: string
}) {
  const styles: Record<typeof tone, string> = {
    amber: 'border-amber-500/30 text-amber-600 dark:text-amber-400',
    emerald: 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400',
    muted: 'border-border text-muted-foreground',
    red: 'border-destructive/30 text-destructive',
  }
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-xs font-medium ${styles[tone]}`}
    >
      {label}
    </span>
  )
}

const TOC = [
  { href: '#overview', label: 'Обзор' },
  { href: '#quick-start', label: 'Быстрый старт' },
  { href: '#appearance', label: 'Внешний вид' },
  { href: '#status', label: 'Жизненный цикл статуса' },
  { href: '#queue', label: 'Очередь менеджеров' },
  { href: '#api', label: 'JavaScript API и события' },
  { href: '#security', label: 'Origin и безопасность' },
  { href: '#endpoints', label: 'Справочник эндпоинтов' },
  { href: '#troubleshooting', label: 'Решение проблем' },
]

export default function AdminDocsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Документация"
        description="Всё, что нужно, чтобы установить, настроить и запустить виджет онлайн-чата Charter Panel на вашем сайте."
        action={
          <Button
            variant="outline"
            size="sm"
            render={<Link href="/admin/livechat" />}
          >
            <ArrowLeft className="size-4" />
            <span>К онлайн-чату</span>
          </Button>
        }
      />

      {/* Навигация по странице */}
      <Card className="p-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          На этой странице
        </p>
        <nav className="flex flex-wrap gap-2">
          {TOC.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {item.label}
            </a>
          ))}
        </nav>
      </Card>

      <Section
        id="overview"
        icon={BookOpen}
        title="Обзор"
        description="Что такое виджет онлайн-чата и как всё устроено."
      >
        <p>
          Виджет онлайн-чата Charter Panel — это один лёгкий скрипт, который вы
          вставляете на любой сайт. Он отрисовывает плавающую кнопку и панель
          чата прямо на странице (без iframe) и в реальном времени соединяет
          посетителей с очередью ваших менеджеров. Сообщения посетителей
          попадают во входящие менеджера, а ответы мгновенно возвращаются
          посетителю.
        </p>
        <p>
          Каждая интеграция — это один <strong>канал</strong> с одним публичным
          API-ключом. Ключ — это всё, что нужно: один и тот же сниппет работает
          на любом домене. Виджет общается с двумя эндпоинтами на{' '}
          <span className="font-mono text-foreground">{PANEL_DOMAIN}</span>:
          входящий эндпоинт для сообщений посетителей и поток Server-Sent Events
          для ответов и истории.
        </p>
      </Section>

      <Section
        id="quick-start"
        icon={Plug}
        title="Быстрый старт"
        description="Создайте виджет и установите его в три шага."
      >
        <ol className="ml-4 list-decimal space-y-2 marker:text-muted-foreground">
          <li>
            Перейдите в <strong>Онлайн-чат</strong> в боковом меню и нажмите{' '}
            <strong>Добавить онлайн-чат</strong>.
          </li>
          <li>
            Выберите хотя бы одного <strong>менеджера</strong> для очереди (поле{' '}
            <strong>домен сайта</strong> необязательно — только для справки),
            затем сохраните.
          </li>
          <li>
            Скопируйте <strong>один сниппет</strong> из диалога установки и
            вставьте его на сайт.
          </li>
        </ol>
        <p>
          <strong>Один способ установки.</strong> На любой сайт и в любой
          фреймворк добавляется один и тот же тег — вставьте его в HTML страницы,
          лучше всего перед закрывающим{' '}
          <span className="font-mono">{'</body>'}</span>:
        </p>
        <DocCodeBlock
          language="html"
          code={`<script async src="${PANEL_URL}/widget.js" data-support-key="lc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"></script>`}
        />
        <p className="text-muted-foreground">
          В сниппете нужен только ключ. В React/Next.js добавьте тот же тег в
          разметку (например, в <span className="font-mono">app/layout.tsx</span>{' '}
          внутри <span className="font-mono">{'<body>'}</span>). Цвет, заголовок,
          приветствие и всё остальное подставляются автоматически из настроек
          канала.
        </p>
      </Section>

      <Section
        id="appearance"
        icon={MessageCircle}
        title="Внешний вид"
        description="Настройте, как выглядят кнопка и панель."
      >
        <p>
          На карточке каждого онлайн-чата откройте иконку кисти, чтобы изменить
          внешний вид виджета. Всё применяется на лету по API-ключу, поэтому код
          на сайте менять не нужно — сниппет несёт только ключ.
        </p>
        <div className="rounded-lg border border-border p-3">
          <Field name="Заголовок">Заголовок панели чата.</Field>
          <Field name="Цвет">
            Фирменный цвет (hex, например{' '}
            <span className="font-mono">#2563eb</span>) для кнопки, шапки и
            исходящих сообщений.
          </Field>
          <Field name="Приветствие">
            Необязательное приветственное облачко над кнопкой.
          </Field>
        </div>
      </Section>

      <Section
        id="status"
        icon={Radio}
        title="Жизненный цикл статуса"
        description="channels.status — единственный источник правды о состоянии интеграции."
      >
        <p>
          Админка отражает <strong>реальное</strong> состояние интеграции, а не
          значение по умолчанию. Только что созданный виджет имеет статус{' '}
          <StatusPill tone="amber" label="pending" /> и отображается как{' '}
          <strong>Не интегрирован</strong>, пока скрипт фактически не подключится
          с вашего живого сайта. Первое успешное рукопожатие переводит его в{' '}
          <StatusPill tone="emerald" label="connected" />, что показывается как{' '}
          <strong>Активен</strong>.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border p-3">
            <div className="mb-1.5">
              <StatusPill tone="amber" label="pending" />
            </div>
            <p className="text-sm text-muted-foreground">
              Создан в админке. Виджет ещё ни разу не подключался с сайта.
              Отображается как <strong>Не интегрирован</strong>.
            </p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="mb-1.5">
              <StatusPill tone="emerald" label="connected" />
            </div>
            <p className="text-sm text-muted-foreground">
              Виджет выполнил рукопожатие с разрешённого origin. Отображается как{' '}
              <strong>Активен</strong>. Именно это вы видите на{' '}
              <span className="font-mono">/admin/livechat</span> и{' '}
              <span className="font-mono">/admin/channels</span>.
            </p>
          </div>
        </div>
        <p className="text-muted-foreground">
          Переход происходит автоматически: когда виджет открывает поток событий
          с установленной страницы, панель помечает канал подключённым. Никаких
          ручных действий не требуется.
        </p>
      </Section>

      <Section
        id="queue"
        icon={Users}
        title="Очередь менеджеров и доступность"
        description="Как распределяются посетители и что будет без менеджеров."
      >
        <p>
          У каждого канала есть упорядоченная <strong>очередь менеджеров</strong>
          . Новые посетители распределяются по очереди по принципу round-robin;
          порядок выбора — это порядок ротации. Как только посетителю назначен
          менеджер, все его последующие сообщения остаются за тем же менеджером.
        </p>
        <div className="rounded-lg border border-border bg-muted/30 p-3.5">
          <p className="font-medium text-foreground">Чат всегда доступен</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Удаление менеджеров никогда не удаляет чат. Канал и его API-ключ
            остаются нетронутыми. Если убрать всех менеджеров, виджет остаётся на
            сайте и показывает посетителю вежливое уведомление вместо ошибки:
          </p>
          <p className="mt-2 rounded-md border border-border bg-background px-3 py-2 text-sm italic text-foreground">
            «К сожалению, сейчас мы не можем ответить. Оставьте сообщение — мы
            свяжемся с вами, как только освободимся.»
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Назначьте менеджера в очередь снова — маршрутизация возобновится
            мгновенно.
          </p>
        </div>
      </Section>

      <Section
        id="api"
        icon={Code2}
        title="JavaScript API и события"
        description="Открывайте виджет программно и подключайтесь �� аналитике."
      >
        <p>
          Глобальный объект —{' '}
          <span className="font-mono">window.SupportChat</span>. Вы можете
          открывать и закрывать виджет, предзаполнять данные посетителя и
          подписываться на события — даже до загрузки скрипта (подписки ставятся
          в очередь). Это необязательно: виджет работает и без единой строки
          кода.
        </p>
        <DocCodeBlock
          language="javascript"
          code={`// Открыть + предзаполнить (ничего не делает, пока виджет не подтверждён)
SupportChat.open({
  name: 'Иван Петров',
  subject: 'Вакансия: Курьер',
  message: 'Здравствуйте, хочу откликнуться...'
})

SupportChat.close()`}
        />
        <p>События (безопасно подписываться из head страницы):</p>
        <DocCodeBlock
          language="javascript"
          code={`SupportChat.on('open',          () => {})
SupportChat.on('close',         () => {})
SupportChat.on('message_sent',  ({ body, count }) => {})
SupportChat.on('first_message', ({ body }) => {})`}
        />
        <p>Пример: своя кнопка плюс цели Яндекс.Метрики:</p>
        <DocCodeBlock
          language="html"
          code={`<script>
  SupportChat.on('open',          () => ym(XXXXXX, 'reachGoal', 'chat_open'))
  SupportChat.on('first_message', () => ym(XXXXXX, 'reachGoal', 'chat_first_message'))
</script>

<button onclick="SupportChat.open({ subject: 'Вакансия: ' + position })">
  Откликнуться
</button>`}
        />
      </Section>

      <Section
        id="security"
        icon={ShieldCheck}
        title="Origin и безопасность"
        description="Как запросы аутентифицируются и ограничиваются."
      >
        <p>
          Эндпоинты аутентифицируются по <strong>API-ключу</strong> канала — без
          cookie сессии, потому что виджет работает кросс-доменно на вашем сайте.
        </p>
        <ul className="ml-4 list-disc space-y-1.5 marker:text-muted-foreground">
          <li>
            API-ключ — это граница доступа: он позволяет писать только в свой
            канал. Виджет работает на любом домене с этим ключом, никакой
            настройки origin не требуется.
          </li>
          <li>
            Ключ — публичный идентификатор канала, а не секрет. Его единственная
            возможность — отправлять сообщения в этот канал.
          </li>
          <li>
            IP посетителя фиксируется на сервере из заголовков прокси и никогда
            не берётся на доверие с клиента.
          </li>
        </ul>
      </Section>

      <Section
        id="endpoints"
        icon={Globe}
        title="Справочник эндпоинтов"
        description={`Все обслуживаются с ${PANEL_DOMAIN}.`}
      >
        <div className="rounded-lg border border-border p-3">
          <Field name="GET /widget.js">
            Встраиваемый скрипт виджета (нейтральное имя; старый путь{' '}
            <span className="font-mono">/livechat.js</span> тоже работает).
          </Field>
          <Field name="GET /widget-sw.js">
            Service worker посетителя (Web Push + установка приложения).
          </Field>
          <Field name="POST /api/livechat/ingest">
            Посетитель → панель: отправляет сообщение. Возвращает{' '}
            <span className="font-mono">{'{ ok, noAgents? }'}</span>.
          </Field>
          <Field name="GET /api/livechat/stream">
            Server-Sent Events: повтор истории + живые ответы менеджеров. При
            рукопожатии помечает канал подключённым.
          </Field>
        </div>
        <p className="text-muted-foreground">
          Все запросы виджета идут напрямую на панель:
        </p>
        <DocCodeBlock
          language="text"
          code={`Скрипт виджета   ${PANEL_URL}/widget.js
Service worker   ${PANEL_URL}/widget-sw.js
Входящие (POST)  ${PANEL_URL}/api/livechat/ingest
Поток (SSE)      ${PANEL_URL}/api/livechat/stream`}
        />
      </Section>

      <Section
        id="troubleshooting"
        icon={AlertTriangle}
        title="Решение проблем"
        description="Частые ситуации и что они означают."
      >
        <div className="space-y-3">
          <div className="rounded-lg border border-border p-3">
            <p className="font-medium text-foreground">
              Карточка показывает «Не интегрирован» после установки сниппета
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Виджет должен один раз подключиться с живого сайта. Откройте
              страницу со сниппетом — статус автоматически сменится на{' '}
              <strong>Активен</strong>. Если он остаётся pending, проверьте, что
              сниппет загружается и ключ верный (вкладка Network).
            </p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="font-medium text-foreground">
              Посетители видят «сейчас мы не можем ответить»
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              На канале нет доступных менеджеров. Добавьте хотя бы одного
              менеджера в очередь — маршрутизация возобновится сразу. Сам чат
              никогда не удаляется.
            </p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="font-medium text-foreground">
              Виджет вообще не появляется
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              API-ключ должен указывать на существующий канал. Неверный или
              удалённый ключ означает, что кнопка не отрисуется — проверьте, что
              в сниппете указан актуальный ключ канала.
            </p>
          </div>
        </div>
      </Section>
    </div>
  )
}
