'use server'

import { revalidatePath } from 'next/cache'
import { requireManager } from '@/lib/auth'
import { listChannels } from '@/lib/data'
import {
  countEnabledRules,
  createRule,
  deleteRule,
  getAutopilotSettings,
  listRules,
  reorderRules,
  setAutopilotEnabled,
  setRuleEnabled,
  updateRule,
} from '@/lib/autopilot/data'
import {
  type AutopilotRule,
  type AutopilotRuleConfig,
  normalizeEvent,
  normalizeRuleConfig,
} from '@/lib/autopilot/match'

export interface AutopilotResult {
  ok: boolean
  message: string
  rule?: AutopilotRule
}

/** A source (channel) the manager can target with autopilot rules. */
export interface AutopilotSource {
  id: string
  name: string
  type: 'telegram' | 'whatsapp' | 'livechat'
}

/** List the manager's channels for the rule editor's source picker. */
export async function getAutopilotSourcesAction(): Promise<AutopilotSource[]> {
  const session = await requireManager()
  const channels = await listChannels(session.sub)
  return channels.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type as AutopilotSource['type'],
  }))
}

/** Raw rule form payload sent from the client (coerced server-side). */
export interface RuleFormInput {
  name: string
  event: string
  enabled: boolean
  config: Partial<AutopilotRuleConfig>
}

const MAX_NAME = 80
const MAX_REPLY = 2000

function cleanName(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, MAX_NAME) : ''
}

/** Validate + normalize a rule form payload into safe stored values. */
function buildRule(input: RuleFormInput): {
  name: string
  event: string
  enabled: boolean
  config: AutopilotRuleConfig
  error?: string
} {
  const config = normalizeRuleConfig(input.config)
  config.replyText = config.replyText.slice(0, MAX_REPLY)
  const event = normalizeEvent(input.event)
  if (!config.replyText.trim()) {
    return { name: '', event, enabled: false, config, error: 'Введите текст автоответа.' }
  }
  if (event === 'no_response' && config.noResponseMinutes < 1) {
    return {
      name: '',
      event,
      enabled: false,
      config,
      error: 'Укажите время ожидания в минутах.',
    }
  }
  return {
    name: cleanName(input.name),
    event,
    enabled: Boolean(input.enabled),
    config,
  }
}

/** Page loader: master switch + all rules + enabled count. */
export async function getAutopilotDataAction(): Promise<{
  enabled: boolean
  rules: AutopilotRule[]
  enabledCount: number
}> {
  const session = await requireManager()
  const [settings, rules, enabledCount] = await Promise.all([
    getAutopilotSettings(session.sub),
    listRules(session.sub),
    countEnabledRules(session.sub),
  ])
  return { enabled: settings.enabled, rules, enabledCount }
}

/** Lightweight status for the inbox toggle (master switch + enabled count). */
export async function getAutopilotStatusAction(): Promise<{
  enabled: boolean
  enabledCount: number
}> {
  const session = await requireManager()
  const [settings, enabledCount] = await Promise.all([
    getAutopilotSettings(session.sub),
    countEnabledRules(session.sub),
  ])
  return { enabled: settings.enabled, enabledCount }
}

/** Flip the master autopilot switch. */
export async function setAutopilotEnabledAction(
  enabled: boolean,
): Promise<AutopilotResult> {
  const session = await requireManager()
  await setAutopilotEnabled(session.sub, Boolean(enabled))
  revalidatePath('/app/autopilot')
  revalidatePath('/app/inbox')
  return {
    ok: true,
    message: enabled ? 'Автопилот включён.' : 'Автопилот выключен.',
  }
}

/** Create a new rule. */
export async function createRuleAction(
  input: RuleFormInput,
): Promise<AutopilotResult> {
  const session = await requireManager()
  const built = buildRule(input)
  if (built.error) return { ok: false, message: built.error }
  const rule = await createRule(session.sub, {
    name: built.name,
    event: built.event,
    enabled: built.enabled,
    config: built.config,
  })
  revalidatePath('/app/autopilot')
  revalidatePath('/app/inbox')
  return { ok: true, message: 'Автоответ создан.', rule }
}

/** Update an existing rule. */
export async function updateRuleAction(
  id: string,
  input: RuleFormInput,
): Promise<AutopilotResult> {
  const session = await requireManager()
  const built = buildRule(input)
  if (built.error) return { ok: false, message: built.error }
  const rule = await updateRule(session.sub, id, {
    name: built.name,
    event: built.event,
    enabled: built.enabled,
    config: built.config,
  })
  if (!rule) return { ok: false, message: 'Правило не найдено.' }
  revalidatePath('/app/autopilot')
  revalidatePath('/app/inbox')
  return { ok: true, message: 'Автоответ обновлён.', rule }
}

/** Toggle a single rule on/off. */
export async function setRuleEnabledAction(
  id: string,
  enabled: boolean,
): Promise<AutopilotResult> {
  const session = await requireManager()
  await setRuleEnabled(session.sub, id, Boolean(enabled))
  revalidatePath('/app/autopilot')
  revalidatePath('/app/inbox')
  return { ok: true, message: 'Готово.' }
}

/** Delete a rule. */
export async function deleteRuleAction(id: string): Promise<AutopilotResult> {
  const session = await requireManager()
  await deleteRule(session.sub, id)
  revalidatePath('/app/autopilot')
  revalidatePath('/app/inbox')
  return { ok: true, message: 'Автоответ удалён.' }
}

/** Persist a new priority ordering. */
export async function reorderRulesAction(
  orderedIds: string[],
): Promise<AutopilotResult> {
  const session = await requireManager()
  if (!Array.isArray(orderedIds)) {
    return { ok: false, message: 'Некорректный порядок.' }
  }
  await reorderRules(session.sub, orderedIds)
  revalidatePath('/app/autopilot')
  return { ok: true, message: 'Порядок сохранён.' }
}
