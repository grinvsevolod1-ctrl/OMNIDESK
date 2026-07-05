/**
 * Per-site live-chat widget configuration.
 *
 * Everything a site owner can tweak from the admin visual editor lives here:
 * look & feel, the conversational content shown inside the chat, the messenger
 * fallbacks, per-site working hours, the off-hours screen copy, and the
 * auto-open behaviour.
 *
 * Storage: the whole blob is persisted under `channels.config.widget` (jsonb),
 * so no schema migration is required. Global defaults (notably working hours)
 * live in `app_settings` and are merged in by {@link resolveWidgetConfig} when
 * a site has not overridden a value. This keeps every existing integration
 * working unchanged while letting each site be configured independently.
 */

export type WidgetPosition = 'right' | 'left'

export interface WidgetWorkingHours {
  /** When false the chat is always live (off-hours screen never shows). */
  enabled: boolean
  /** IANA timezone all the time math is anchored to, e.g. "Europe/Moscow". */
  tz: string
  /** Inclusive open time. */
  startHour: number
  startMinute: number
  /** Exclusive close time. Supports overnight windows (end < start). */
  endHour: number
  endMinute: number
  /** Active weekdays (0=Sunday … 6=Saturday). Empty = no working day. */
  days: number[]
}

export type WidgetMessengerType = 'telegram' | 'whatsapp' | 'custom'

export interface WidgetMessenger {
  type: WidgetMessengerType
  /** Button label, e.g. "Telegram", "Наш чат". */
  label: string
  /**
   * For telegram/custom: a full URL. For whatsapp: a phone number in any
   * format (the wa.me link is built at render time).
   */
  value: string
}

export interface WidgetAppearance {
  /** Header title. */
  title: string
  /** Primary brand color (hex). */
  color: string
  /** Greeting teaser bubble over the launcher. Empty = no teaser. */
  greeting: string
  /** Secondary line under the greeting teaser. */
  greetingSub: string
  /** Launcher / panel side. */
  position: WidgetPosition
  /** Agent display name shown in the header. */
  agentName: string
  /**
   * Optional agent avatar as an uploaded image data URL (downscaled in the
   * editor). Falls back to an icon when empty.
   */
  agentAvatar: string
  /** Short status line under the title, e.g. "Обычно отвечаем за 5 минут". */
  subtitle: string
}

export interface WidgetContent {
  /** Agent bubble shown automatically when the chat opens (empty = none). */
  welcomeMessage: string
  /** Quick-reply chips; clicking one prefills the input. */
  quickReplies: string[]
  /** Composer placeholder text. */
  inputPlaceholder: string
  /** Show the messenger buttons inside the chat during working hours too. */
  showMessengers: boolean
  /** Heading above the inline messenger buttons. */
  messengersTitle: string
}

export interface WidgetOffline {
  /** Off-hours screen title. */
  title: string
  /** Off-hours screen body text. */
  text: string
}

export interface WidgetAutoOpen {
  /** Automatically pop the panel open after a delay. */
  enabled: boolean
  /** Delay in seconds before auto-opening. */
  delaySec: number
}

export interface LivechatWidgetConfig {
  appearance: WidgetAppearance
  content: WidgetContent
  messengers: WidgetMessenger[]
  workingHours: WidgetWorkingHours
  offline: WidgetOffline
  autoOpen: WidgetAutoOpen
}

/** Global defaults an admin can set once and have new sites inherit. */
export interface LivechatGlobalDefaults {
  workingHours: WidgetWorkingHours
}

export const DEFAULT_WORKING_HOURS: WidgetWorkingHours = {
  enabled: true,
  tz: 'Europe/Moscow',
  startHour: 8,
  startMinute: 0,
  endHour: 17,
  endMinute: 0,
  // Mon–Fri by default.
  days: [1, 2, 3, 4, 5],
}

export function defaultWidgetConfig(): LivechatWidgetConfig {
  return {
    appearance: {
      title: 'Чат поддержки',
      color: '#2563eb',
      greeting: '',
      greetingSub: 'Нажмите, чтобы начать',
      position: 'right',
      agentName: '',
      agentAvatar: '',
      subtitle: 'Мы на связи',
    },
    content: {
      welcomeMessage: 'Здравствуйте! Чем можем помочь?',
      quickReplies: [],
      inputPlaceholder: 'Введите сообщение...',
      showMessengers: false,
      messengersTitle: 'Или напишите в мессенджер',
    },
    messengers: [],
    workingHours: { ...DEFAULT_WORKING_HOURS },
    offline: {
      title: 'Мы сейчас не работаем',
      text: 'Оставьте сообщение или напишите нам в мессенджер — мы ответим, как только вернёмся.',
    },
    autoOpen: {
      enabled: false,
      delaySec: 15,
    },
  }
}

/* ------------------------------ helpers ----------------------------- */

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function int(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function hexColor(v: unknown, fallback: string): string {
  const s = String(v ?? '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : fallback
}

function stringList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .slice(0, max)
}

function normalizeWorkingHours(
  raw: unknown,
  base: WidgetWorkingHours,
): WidgetWorkingHours {
  const r = (raw ?? {}) as Record<string, unknown>
  const days = Array.isArray(r.days)
    ? Array.from(
        new Set(
          r.days
            .map((d) => int(d, -1, 0, 6))
            .filter((d) => d >= 0 && d <= 6),
        ),
      ).sort((a, b) => a - b)
    : base.days
  return {
    enabled: bool(r.enabled, base.enabled),
    tz: str(r.tz, base.tz) || base.tz,
    startHour: int(r.startHour, base.startHour, 0, 23),
    startMinute: int(r.startMinute, base.startMinute, 0, 59),
    endHour: int(r.endHour, base.endHour, 0, 23),
    endMinute: int(r.endMinute, base.endMinute, 0, 59),
    days,
  }
}

/**
 * Reject anything that could become an executable href when the widget renders
 * `<a href={value}>`. The widget is injected into the customer's own page, so a
 * `javascript:`/`data:`/`vbscript:` value here would be stored-XSS on their
 * site. We allow only the schemes that make sense per messenger type.
 */
function isSafeMessengerValue(type: WidgetMessengerType, value: string): boolean {
  // WhatsApp values are phone numbers; the wa.me link is built from digits at
  // render time, so they can never become a dangerous href.
  if (type === 'whatsapp') return value.replace(/\D/g, '').length >= 7

  // Telegram deep links: native tg:// or a regular http(s) t.me / telegram.me.
  if (type === 'telegram') {
    if (/^tg:\/\//i.test(value)) return true
    try {
      const u = new URL(value)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
      return /(^|\.)t\.me$/.test(u.hostname) || /(^|\.)telegram\.me$/.test(u.hostname)
    } catch {
      return false
    }
  }

  // Custom: any http(s) URL, but nothing else.
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function normalizeMessengers(raw: unknown): WidgetMessenger[] {
  if (!Array.isArray(raw)) return []
  const out: WidgetMessenger[] = []
  for (const item of raw) {
    const r = (item ?? {}) as Record<string, unknown>
    const type = ['telegram', 'whatsapp', 'custom'].includes(
      String(r.type),
    )
      ? (String(r.type) as WidgetMessengerType)
      : 'custom'
    const value = String(r.value ?? '').trim().slice(0, 300)
    if (!value) continue
    // Drop entries whose value isn't a safe href for their type (XSS guard).
    if (!isSafeMessengerValue(type, value)) continue
    const fallbackLabel =
      type === 'telegram'
        ? 'Telegram'
        : type === 'whatsapp'
          ? 'WhatsApp'
          : 'Написать'
    out.push({
      type,
      label: (String(r.label ?? '').trim() || fallbackLabel).slice(0, 40),
      value,
    })
    if (out.length >= 8) break
  }
  return out
}

/**
 * Merge a raw stored widget blob with global defaults and hardcoded defaults,
 * producing a fully-populated, validated config. Safe to call on `undefined`.
 */
export function resolveWidgetConfig(
  raw: unknown,
  globals?: LivechatGlobalDefaults | null,
): LivechatWidgetConfig {
  const base = defaultWidgetConfig()
  const defaultsWorkingHours = globals?.workingHours ?? base.workingHours
  const r = (raw ?? {}) as Record<string, unknown>
  const ap = (r.appearance ?? {}) as Record<string, unknown>
  const co = (r.content ?? {}) as Record<string, unknown>
  const off = (r.offline ?? {}) as Record<string, unknown>
  const ao = (r.autoOpen ?? {}) as Record<string, unknown>

  return {
    appearance: {
      title: str(ap.title, base.appearance.title).slice(0, 80) || base.appearance.title,
      color: hexColor(ap.color, base.appearance.color),
      greeting: str(ap.greeting, base.appearance.greeting).slice(0, 120),
      greetingSub:
        str(ap.greetingSub, base.appearance.greetingSub).slice(0, 80),
      position: ap.position === 'left' ? 'left' : 'right',
      agentName: str(ap.agentName, base.appearance.agentName).slice(0, 60),
      // Generous cap: avatars are stored as small downscaled data URLs
      // (~160px JPEG), so allow up to ~256KB instead of a plain-URL length.
      agentAvatar: str(ap.agentAvatar, base.appearance.agentAvatar).slice(0, 262144),
      subtitle: str(ap.subtitle, base.appearance.subtitle).slice(0, 80),
    },
    content: {
      welcomeMessage:
        str(co.welcomeMessage, base.content.welcomeMessage).slice(0, 500),
      quickReplies: stringList(co.quickReplies, 6).map((s) => s.slice(0, 60)),
      inputPlaceholder:
        str(co.inputPlaceholder, base.content.inputPlaceholder).slice(0, 80) ||
        base.content.inputPlaceholder,
      showMessengers: bool(co.showMessengers, base.content.showMessengers),
      messengersTitle:
        str(co.messengersTitle, base.content.messengersTitle).slice(0, 60),
    },
    messengers: normalizeMessengers(r.messengers),
    workingHours: normalizeWorkingHours(r.workingHours, defaultsWorkingHours),
    offline: {
      title: str(off.title, base.offline.title).slice(0, 80) || base.offline.title,
      text: str(off.text, base.offline.text).slice(0, 300) || base.offline.text,
    },
    autoOpen: {
      enabled: bool(ao.enabled, base.autoOpen.enabled),
      delaySec: int(ao.delaySec, base.autoOpen.delaySec, 1, 600),
    },
  }
}

export function resolveGlobalDefaults(raw: unknown): LivechatGlobalDefaults {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    workingHours: normalizeWorkingHours(r.workingHours, DEFAULT_WORKING_HOURS),
  }
}

/** Build a wa.me link from a raw phone string (digits only). */
export function whatsappLink(raw: string): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (digits.length < 7) return null
  return `https://wa.me/${digits}`
}
