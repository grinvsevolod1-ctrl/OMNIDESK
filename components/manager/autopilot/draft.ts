import {
  DEFAULT_RULE_CONFIG,
  type AutopilotEvent,
  type AutopilotRule,
  type AutopilotRuleConfig,
} from '@/lib/autopilot/match'

export const MAX_NAME = 80
export const MAX_REPLY = 2000

/** Human-readable label + short hint for each trigger event. */
export const EVENT_META: Record<AutopilotEvent, { label: string; hint: string }> = {
  first_message: {
    label: 'Первое сообщение',
    hint: 'Срабатывает на самое первое сообщение в новом диалоге — приветствие.',
  },
  any_message: {
    label: 'Любое сообщение',
    hint: 'Срабатывает на каждое входящее сообщение (удобно с условием по ключевым словам).',
  },
  no_response: {
    label: 'Менеджер долго не отвечает',
    hint: 'Срабатывает, если менеджер не ответил в течение заданного времени.',
  },
}

export const EVENTS: AutopilotEvent[] = [
  'first_message',
  'any_message',
  'no_response',
]

export const WORKING_HOURS_LABELS: Record<
  AutopilotRuleConfig['requireWorkingHours'],
  string
> = {
  any: 'В любое время',
  inside: 'Только в рабочие часы',
  outside: 'Только в нерабочее время',
}

/** A rule being edited in the form, with keywords kept as raw editable text. */
export interface DraftState {
  name: string
  event: AutopilotEvent
  enabled: boolean
  sources: string[]
  keywordsText: string
  keywordMatch: AutopilotRuleConfig['keywordMatch']
  requireWorkingHours: AutopilotRuleConfig['requireWorkingHours']
  noResponseMinutes: number
  replyText: string
  delaySec: number
  oncePerConversation: boolean
}

export function draftFromRule(rule: AutopilotRule): DraftState {
  return {
    name: rule.name,
    event: rule.event,
    enabled: rule.enabled,
    sources: rule.config.sources,
    keywordsText: rule.config.keywords.join(', '),
    keywordMatch: rule.config.keywordMatch,
    requireWorkingHours: rule.config.requireWorkingHours,
    noResponseMinutes: rule.config.noResponseMinutes,
    replyText: rule.config.replyText,
    delaySec: rule.config.delaySec,
    oncePerConversation: rule.config.oncePerConversation,
  }
}

export function emptyDraft(): DraftState {
  return {
    name: '',
    event: 'first_message',
    enabled: true,
    sources: [],
    keywordsText: '',
    keywordMatch: DEFAULT_RULE_CONFIG.keywordMatch,
    requireWorkingHours: DEFAULT_RULE_CONFIG.requireWorkingHours,
    noResponseMinutes: DEFAULT_RULE_CONFIG.noResponseMinutes,
    replyText: '',
    delaySec: DEFAULT_RULE_CONFIG.delaySec,
    oncePerConversation: DEFAULT_RULE_CONFIG.oncePerConversation,
  }
}

/** Parse the comma/newline separated keyword text into a clean string array. */
export function parseKeywords(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
}

/** Build the action payload from a draft. */
export function draftToPayload(d: DraftState) {
  return {
    name: d.name,
    event: d.event,
    enabled: d.enabled,
    config: {
      sources: d.sources,
      keywords: d.event === 'no_response' ? [] : parseKeywords(d.keywordsText),
      keywordMatch: d.keywordMatch,
      requireWorkingHours: d.requireWorkingHours,
      noResponseMinutes: d.noResponseMinutes,
      replyText: d.replyText,
      delaySec: d.delaySec,
      oncePerConversation: d.oncePerConversation,
    },
  }
}
