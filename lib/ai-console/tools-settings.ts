import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import { generateSalesScenario } from '@/lib/ai/manager-brain'
import {
  getAiAssistSettings,
  updateAiAssistSettings,
  listKnowledge,
  countLessons,
  listAiEnrolledConversations,
} from '@/lib/data/ai-assist'
import { countManualCorrections } from '@/lib/data/ai-assist-corrections'
import { addDirective, countDirectives } from '@/lib/data/ai-directives'
import type { ConsoleIntent } from './intents'
import { AGGRESSIVENESS_LABELS, type SettingsRevert } from './assistant'
import { pluralRules, type RunState } from './run-state'

/**
 * Seller-configuration tools: master switch, tone, persona, aggressiveness,
 * model + params, the scenario generator and the panel opener. Guarded actions
 * (disable, max aggressiveness) set `state.pending` instead of applying.
 */

/** Compact status string the model reads to ground its answers. */
async function readStatus() {
  const [settings, knowledge, lessons, corrections, enrolled, directives] =
    await Promise.all([
      getAiAssistSettings(),
      listKnowledge(),
      countLessons(),
      countManualCorrections(),
      listAiEnrolledConversations(),
      countDirectives(),
    ])
  return {
    enabled: settings.enabled,
    tone: settings.tone,
    persona: settings.persona || '(не задано)',
    aggressiveness: settings.aggressiveness,
    aggressivenessLabel:
      AGGRESSIVENESS_LABELS[settings.aggressiveness] ?? 'Сбалансированный',
    model: settings.model || '(по умолчанию)',
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    knowledgeCount: knowledge.length,
    lessonCount: lessons,
    correctionCount: corrections,
    enrolledDialogs: enrolled.length,
    directiveCount: directives,
  }
}

export function settingsTools(state: RunState) {
  return {
    getStatus: tool({
      description:
        'Прочитать текущее состояние ИИ-менеджера: включён ли он, тон, персона, уровень агрессивности, модель, счётчики базы знаний/уроков/правок/диалогов. Вызывай перед тем, как что-то объяснять или менять.',
      inputSchema: z.object({}),
      execute: async () => readStatus(),
    }),

    setEnabled: tool({
      description:
        'Включить ИИ-менеджера (главный переключатель). Для ВЫКЛЮЧЕНИЯ передай enabled=false — но выключение требует подтверждения администратора, оно не применится сразу, а вернёт needsConfirmation.',
      inputSchema: z.object({ enabled: z.boolean() }),
      execute: async ({ enabled }) => {
        // Guard: disabling the AI is high-impact → require confirmation.
        if (!enabled) {
          state.pending = {
            kind: 'disable',
            label: 'Выключить ИИ-менеджера',
            detail:
              'После выключения ИИ перестанет отвечать клиентам во всех диалогах.',
          }
          return { ok: true, needsConfirmation: true }
        }
        await updateAiAssistSettings({ enabled: true })
        state.settingsChanged = true
        state.actions.push({
          kind: 'enabled',
          label: 'Включил ИИ-менеджера',
          revert: { enabled: state.baseline.enabled },
        })
        return { ok: true, enabled: true }
      },
    }),

    setTone: tool({
      description:
        'Сменить тон общения ИИ-менеджера. professional — деловой, friendly — дружелюбный, persuasive — убедительный/продающий.',
      inputSchema: z.object({
        tone: z.enum(['professional', 'friendly', 'persuasive']),
      }),
      execute: async ({ tone }) => {
        await updateAiAssistSettings({ tone })
        state.settingsChanged = true
        const label =
          tone === 'professional'
            ? 'деловой'
            : tone === 'friendly'
              ? 'дружелюбный'
              : 'убедительный'
        state.actions.push({
          kind: 'tone',
          label: `Тон → ${label}`,
          revert: { tone: state.baseline.tone },
        })
        return { ok: true, tone }
      },
    }),

    setPersona: tool({
      description:
        'Задать описание компании/персоны ИИ-менеджера (чем занимается компания, как себя вести, что предлагать). Полностью перезаписывает текущее описание.',
      inputSchema: z.object({
        persona: z.string().min(1).max(2000),
      }),
      execute: async ({ persona }) => {
        await updateAiAssistSettings({ persona: persona.trim() })
        state.settingsChanged = true
        state.actions.push({
          kind: 'persona',
          label: 'Обновил описание компании',
          revert: { persona: state.baseline.persona },
        })
        return { ok: true }
      },
    }),

    generateScenario: tool({
      description:
        'Собрать ИИ-продавца «с нуля» по описанию бизнеса. Вызывай, когда админ описывает свою компанию/продукт и просит «настрой продавца», «сделай сценарий», «собери под мой бизнес». Модель сгенерирует персону (сценарий) и набор правил, применит персону (перезаписав старую) и сохранит правила как прямые указания. Передай businessDescription — всё, что админ рассказал о бизнесе.',
      inputSchema: z.object({
        businessDescription: z.string().min(10).max(4000),
      }),
      execute: async ({ businessDescription }) => {
        const scenario = await generateSalesScenario(businessDescription.trim())
        if (!scenario) {
          return { ok: false, reason: 'generation_unavailable' }
        }
        if (scenario.persona) {
          await updateAiAssistSettings({ persona: scenario.persona })
          state.settingsChanged = true
          state.actions.push({
            kind: 'persona',
            label: 'Собрал сценарий продавца под бизнес',
            revert: { persona: state.baseline.persona },
          })
        }
        let savedDirectives = 0
        for (const body of scenario.directives) {
          try {
            await addDirective(body)
            savedDirectives += 1
          } catch {
            /* cap reached or empty — skip, best-effort */
          }
        }
        if (savedDirectives > 0) {
          state.actions.push({
            kind: 'directive',
            label: `Добавил ${savedDirectives} ${pluralRules(savedDirectives)} под бизнес`,
          })
        }
        return {
          ok: true,
          personaSet: !!scenario.persona,
          directivesAdded: savedDirectives,
          persona: scenario.persona,
          directives: scenario.directives,
        }
      },
    }),

    setAggressiveness: tool({
      description:
        'Настроить, насколько жёстко ИИ дожимает клиента до цели. 0 — мягкий, 1 — сбалансированный, 2 — напористый, 3 — максимальный дожим. Уровень 3 требует подтверждения администратора и не применится сразу.',
      inputSchema: z.object({
        level: z.number().int().min(0).max(3),
      }),
      execute: async ({ level }) => {
        // Guard: maximum pressure is high-impact → require confirmation.
        if (level === 3) {
          state.pending = {
            kind: 'max_aggressiveness',
            label: 'Включить максимальный дожим',
            detail:
              'Уровень 3 — предельное давление на клиента вплоть до передачи документов.',
          }
          return { ok: true, needsConfirmation: true }
        }
        await updateAiAssistSettings({ aggressiveness: level })
        state.settingsChanged = true
        state.actions.push({
          kind: 'aggressiveness',
          label: `Агрессивность → ${AGGRESSIVENESS_LABELS[level]}`,
          revert: { aggressiveness: state.baseline.aggressiveness },
        })
        return { ok: true, level, label: AGGRESSIVENESS_LABELS[level] }
      },
    }),

    setModelParams: tool({
      description:
        'Настроить параметры модели ИИ-менеджера: temperature (0..2, креативность) и maxTokens (длина ответа). Меняй только то, что попросил админ.',
      inputSchema: z.object({
        temperature: z.number().min(0).max(2).optional(),
        maxTokens: z.number().int().min(50).max(4000).optional(),
      }),
      execute: async ({ temperature, maxTokens }) => {
        if (temperature == null && maxTokens == null) {
          return { ok: false, reason: 'nothing_to_change' }
        }
        await updateAiAssistSettings({
          temperature: temperature ?? undefined,
          maxTokens: maxTokens ?? undefined,
        })
        state.settingsChanged = true
        const parts: string[] = []
        const revert: SettingsRevert = {}
        if (temperature != null) {
          parts.push(`temperature ${temperature}`)
          revert.temperature = state.baseline.temperature
        }
        if (maxTokens != null) {
          parts.push(`ответ ${maxTokens} токенов`)
          revert.maxTokens = state.baseline.maxTokens
        }
        state.actions.push({
          kind: 'model',
          label: `Модель: ${parts.join(', ')}`,
          revert,
        })
        return { ok: true, temperature, maxTokens }
      },
    }),

    setModel: tool({
      description:
        'Сменить модель ИИ-менеджера (тот «мозг», что пишет клиентам). Вызывай, когда админ просит «поставь модель …», «сделай бота умнее/дешевле», «верни модель по умолчанию». Популярные варианты: openai/gpt-4.1 (баланс, по умолчанию), openai/gpt-4.1-mini (быстрее и дешевле), openai/gpt-5.3-chat (максимально живой). Чтобы вернуть значение по умолчанию, передай reset=true. Если админ называет модель расплывчато («поумнее»), предложи конкретный вариант и подтверди, прежде чем менять.',
      inputSchema: z.object({
        model: z.string().min(2).max(80).optional(),
        reset: z.boolean().optional(),
      }),
      execute: async ({ model, reset }) => {
        if (!reset && !model?.trim()) {
          return { ok: false, reason: 'nothing_to_change' }
        }
        const next = reset ? '' : model!.trim()
        await updateAiAssistSettings({ model: next })
        state.settingsChanged = true
        state.actions.push({
          kind: 'model',
          label: reset
            ? 'Модель: сброшена на значение по умолчанию'
            : `Модель: ${next}`,
          revert: { model: state.baseline.model },
        })
        return { ok: true, model: next || '(по умолчанию)' }
      },
    }),

    openPanel: tool({
      description:
        'Открыть админу рабочую панель для действий, которые лучше делать руками: settings (все настройки), aggressiveness (ползунок дожима), knowledge (база знаний), training (обучение ассистента на реальных диалогах), corrections (правки к конкретным сообщениям), dialogs (подключение ИИ к диалогам), logs (журнал). Вызывай, когда задача требует ручной работы или админ просит «покажи/открой».',
      inputSchema: z.object({
        panel: z.enum([
          'settings',
          'aggressiveness',
          'knowledge',
          'training',
          'corrections',
          'dialogs',
          'logs',
        ]),
      }),
      execute: async ({ panel }) => {
        state.openPanel = panel as ConsoleIntent
        return { ok: true, panel }
      },
    }),
  }
}
