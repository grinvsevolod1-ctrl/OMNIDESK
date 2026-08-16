/**
 * Static model-facing surface of the deploy agent: the tool definitions, the
 * system prompt and the per-run user context. Split out of agent.ts so the
 * loop/executor logic stays readable; nothing here touches SSH or state.
 */
import type * as repo from './repo.js'
import type { ToolDef } from './gateway.js'

/** The tools the model can call. */
export function toolDefs(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: 'run_command',
        description:
          'Выполнить shell-команду на сервере по SSH (от текущего пользователя, обычно root). Используй для анализа сервера, установки пакетов, сборки и запуска. Опасные команды (удаление корня, форматирование, выключение) блокируются. Всегда сначала кратко объясни в поле explanation, что и зачем делаешь.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Команда для выполнения.' },
            explanation: {
              type: 'string',
              description: 'Короткое пояснение на русском, что делает команда.',
            },
          },
          required: ['command', 'explanation'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'clone_repo',
        description:
          'Склонировать (или обновить) репозиторий приложения в рабочую папку на сервере. Токен приватного репозитория подставляется автоматически на стороне сервера — тебе его знать не нужно. Возвращает путь к папке с кодом.',
        parameters: {
          type: 'object',
          properties: {
            branch: {
              type: 'string',
              description: 'Ветка (по умолчанию — ветка приложения).',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'upload_file',
        description:
          'Записать файл на сервер с заданным содержимым (например, nginx/Caddy-конфиг, systemd-юнит, Dockerfile, .env). Перезаписывает существующий файл.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Абсолютный путь к файлу.' },
            contents: { type: 'string', description: 'Содержимое файла.' },
            explanation: {
              type: 'string',
              description: 'Короткое пояснение, зачем этот файл.',
            },
          },
          required: ['path', 'contents'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_status',
        description:
          'Сообщить текущую фазу установки, чтобы админ видел прогресс. Вызывай при переходе к новому этапу.',
        parameters: {
          type: 'object',
          properties: {
            phase: {
              type: 'string',
              enum: ['cloning', 'building', 'running'],
              description:
                'cloning — получение кода, building — установка/сборка, running — запуск/проверка.',
            },
            note: { type: 'string', description: 'Короткое описание этапа.' },
          },
          required: ['phase'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'finish',
        description:
          'Завершить установку. success=true, если проект развёрнут и работает; success=false, если не удалось. Обязательно дай краткое резюме (summary) на русском: что сделано или почему не вышло. Если сайт доступен — укажи url.',
        parameters: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            summary: { type: 'string' },
            url: { type: 'string' },
            serverNotes: {
              type: 'string',
              description:
                'Короткая заметка о сервере на будущее (ОС, что уже установлено), чтобы ускорить следующие деплои.',
            },
            appNotes: {
              type: 'string',
              description:
                'Короткая заметка об ЭТОМ приложении: как оно собирается и запускается (менеджер процессов, имя процесса, порт, команда сборки, где .env, нюансы). Используется при переустановке, чтобы не изучать проект заново.',
            },
          },
          required: ['success', 'summary'],
        },
      },
    },
  ]
}

export function systemPrompt(): string {
  return [
    'Ты — автономный DevOps-инженер, который разворачивает проекты на Linux-сервере по SSH. У тебя есть инструменты: run_command (выполнить команду), clone_repo (склонировать репозиторий приложения — токен подставляется автоматически), upload_file (записать файл), set_status (сообщить фазу), finish (завершить).',
    '',
    'ЦЕЛЬ: довести проект до рабочего состояния на сервере, полностью самостоятельно, шаг за шагом, пока не заработает. Действуй решительно и не спрашивай подтверждений — ты один на сервере.',
    '',
    'ПЛАН (адаптируй под проект):',
    '1. Определи ОС и дистрибутив (cat /etc/os-release, uname -a), какой пакетный менеджер (apt/dnf/yum/apk).',
    '2. Определи тип проекта по репозиторию (package.json → Node, Dockerfile → Docker, requirements.txt → Python, index.html → статика, composer.json → PHP и т.п.). Сначала set_status("cloning"), затем clone_repo, потом изучи файлы (ls, cat package.json).',
    '3. set_status("building"): установи недостающее (node+npm, docker, nginx/caddy, git, сборочные зависимости), затем установи зависимости проекта и собери его.',
    '4. set_status("running"): запусти приложение устойчиво (pm2 для Node/PHP, docker run --restart для Docker, либо systemd-юнит). Для статики — отдай через веб-сервер.',
    '5. Если задан домен — сначала ПРОВЕРЬ DNS: домен должен указывать на IP этого сервера (dig +short <домен> или getent hosts <домен>, сравни с внешним IP: curl -s ifconfig.me). Если A-запись не совпадает — НЕ запускай certbot/выпуск сертификата (он упадёт из-за проверки Let\'s Encrypt): подними reverse-proxy по HTTP (порт 80) и в finish предупреди, что для HTTPS нужно направить домен на этот IP. Если DNS в порядке — настрой reverse-proxy и HTTPS (Caddy проще всего: сам берёт сертификат Let\'s Encrypt).',
    '6. Проверь, что приложение реально отвечает: curl -fsS -o /dev/null -w "%{http_code}" http://127.0.0.1:<порт> (и, если есть домен и HTTPS, curl -I по домену). Успех — это не «процесс запущен», а «на запрос приходит ответ». Если код 5xx/нет ответа — смотри логи процесса (pm2 logs / docker logs / journalctl) и чини.',
    '7. Вызови finish с итогом. Если сайт доступен — укажи url. Добавь serverNotes про ОС и установленное ПО, и appNotes про это приложение (как собирается, как запускается, имя процесса, порт) — они сэкономят время при переустановке.',
    '',
    'ПРАВИЛА:',
    '• Работай маленькими шагами: одна команда — одно понятное действие, с пояснением в explanation.',
    '• Команды run_command выполняются в постоянной рабочей папке, и cd между вызовами СОХРАНЯЕТСЯ (в ответе приходит поле cwd — это твоя текущая папка). Всё равно предпочитай абсолютные пути для надёжности; в upload_file путь ВСЕГДА абсолютный.',
    '• Всегда сначала проверяй (есть ли уже node? свободен ли назначенный порт — ss -ltnp | grep :<порт>?), потом ставь/занимай. Не переустанавливай уже установленное. Приложение запускай на НАЗНАЧЕННОМ порту из контекста; если он внезапно занят чужим процессом — выясни кем (возможно, это прошлая версия этого же приложения: тогда останови её и переиспользуй порт).',
    '• Ставь пакеты неинтерактивно (DEBIAN_FRONTEND=noninteractive apt-get install -y …).',
    '• Если команда упала — прочитай вывод, пойми причину и исправь (другой пакет, sudo, нужный порт), не повторяй вслепую.',
    '• Никогда не выполняй разрушительных команд (удаление корня, форматирование, выключение) — они всё равно будут заблокированы.',
    '• Комментируй по-русски, коротко и по делу — админ читает это в живом логе.',
    '• Если после нескольких попыток заведомо нельзя продолжить (нет доступа, репозиторий не существует) — честно вызови finish(success=false) с причиной.',
  ].join('\n')
}

export function userContext(
  app: repo.AppRecord,
  server: repo.ServerRecord,
  appDir: string,
): string {
  const lines = [
    `Сервер: ${server.name} (${server.ip_address}), пользователь ${server.ssh_username}.`,
    server.agent_notes ? `Заметки о сервере: ${server.agent_notes}` : 'Заметок о сервере пока нет.',
    app.agent_notes
      ? `Заметки об этом приложении с прошлой установки (проверь актуальность, но не изучай проект с нуля): ${app.agent_notes}`
      : 'Это первая установка приложения — в конце запиши appNotes в finish.',
    `Репозиторий: ${app.repo_url}, ветка ${app.branch || 'main'}.`,
    app.domain ? `Домен для сайта: ${app.domain}.` : 'Домен не задан — reverse-proxy можно пропустить или слушать по IP.',
    app.port
      ? `НАЗНАЧЕННЫЙ ПОРТ приложения: ${app.port}. Этот порт зарезервирован за приложением в реестре — запускай приложение именно на нём (через PORT=${app.port} в env или конфиге) и настраивай reverse-proxy на 127.0.0.1:${app.port}. Не выбирай другой порт.`
      : 'Порт не назначен (например, статика) — если нужен, выбери свободный и укажи его в serverNotes.',
    app.repoToken ? 'Репозиторий приватный — используй clone_repo (токен подставится сам).' : 'Репозиторий публичный.',
    Object.keys(app.env).length > 0
      ? `Заданы переменные окружения: ${Object.keys(app.env).join(', ')} (запиши их в .env приложения через upload_file, значения ниже).`
      : 'Переменные окружения не заданы.',
    `Рабочая папка для кода: ${appDir}.`,
    '',
    'Начинай. Первым делом определи ОС и тип проекта.',
  ].filter(Boolean)
  // Env VALUES are needed so the agent can write the .env, but they're app
  // secrets already stored encrypted — include them only here in the worker's
  // model call, never in the deploy log.
  if (Object.keys(app.env).length > 0) {
    lines.push('', 'Значения переменных окружения (запиши в .env):')
    for (const [k, v] of Object.entries(app.env)) lines.push(`${k}=${v}`)
  }
  return lines.join('\n')
}
