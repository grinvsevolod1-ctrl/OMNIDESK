import 'server-only'

/**
 * Генерация сообщений «клиента» для ИИ-автопилота god-мессенджера.
 *
 * Автопилот играет СТОРОНУ КЛИЕНТА: пишет первое входящее и отвечает
 * менеджеру как живой человек. Модель дёргается напрямую через AI Gateway
 * (как и мозг менеджера), а результат прогоняется через humanizeReply —
 * общий скраббер анти-детекта (убирает длинные тире, markdown, штампы),
 * чтобы клиента-бота нельзя было спалить.
 */

import { GATEWAY_URL, MODEL, humanizeReply } from '@/lib/ai/brain/core'
import type { AutopilotPersona } from './types'

/** Ход диалога так, как его видит модель. */
export interface AutopilotTurn {
  role: 'client' | 'manager'
  body: string
}

/**
 * Железные правила, которые НЕЛЬЗЯ нарушать ни при каких обстоятельствах.
 * Здесь и живость речи, и полный запрет любых ИИ-признаков.
 */
function ironRules(): string {
  return [
    'ТЫ — ЖИВОЙ ЧЕЛОВЕК, реальный клиент, который сам написал в компанию. Ты НЕ ИИ, НЕ бот, НЕ ассистент.',
    'Тебя НЕВОЗМОЖНО заподозрить в том, что ты бот. Пиши как обычный человек в мессенджере.',
    'СТРОГО ЗАПРЕЩЕНО: длинное тире (—), среднее тире (–), любые типографские тире. Только обычный дефис или запятая.',
    'СТРОГО ЗАПРЕЩЕНО: markdown, звёздочки, решётки, списки, нумерация, заголовки, кавычки-ёлочки вокруг всего сообщения.',
    'СТРОГО ЗАПРЕЩЕНО: канцелярит и штампы вроде «Здравствуйте! Меня интересует...», «Благодарю за информацию», «Рад помочь», «С уважением».',
    'СТРОГО ЗАПРЕЩЕНО: писать что ты ИИ, языковая модель, ассистент; извиняться как ассистент; выдавать инструкции.',
    'Пиши коротко и по-человечески, как в реальном чате. Живая разговорная речь, можно неидеально.',
    'Отвечай ОДНИМ сообщением. Без подписи, без темы письма, без приветствий-формальностей если это не первое сообщение.',
    'Никогда не переходи на сторону менеджера и не помогай ему продавать. Ты покупатель со своими интересами.',
  ].join('\n')
}

/** Портрет клиента для промпта. */
function personaBlock(persona: AutopilotPersona): string {
  return [
    `Имя: ${persona.name}, город: ${persona.city}.`,
    `Твой характер: ${persona.archetype}.`,
    `Манера письма: ${persona.style}.`,
    `Настроение: ${persona.mood}.`,
    `Чего ты хочешь: ${persona.goal}.`,
  ].join('\n')
}

async function callGateway(
  system: string,
  user: string,
  model: string,
  temperature: number,
): Promise<string | null> {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) return null
  try {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature,
        max_tokens: 300,
      }),
    })
    if (!res.ok) {
      console.warn('[god-autopilot] gateway HTTP', res.status)
      return null
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>
    }
    const raw = data.choices?.[0]?.message?.content ?? ''
    // Снять обрамляющие кавычки и прогнать общий анти-детект скраббер.
    const clean = humanizeReply(raw.trim().replace(/^["'«»]+|["'«»]+$/g, ''))
    return clean || null
  } catch (err) {
    console.warn('[god-autopilot] generation failed:', err)
    return null
  }
}

/**
 * Первое входящее сообщение «клиента». Высокая температура + случайная
 * персона гарантируют, что открытия не похожи одно на другое.
 */
export async function generateOpeningMessage(
  topic: string,
  persona: AutopilotPersona,
  model: string | null,
): Promise<string | null> {
  const system = [
    'Ты пишешь ПЕРВОЕ сообщение в компанию как реальный потенциальный клиент.',
    '',
    'ТЕМАТИКА КОМПАНИИ (это ЗАКОН, отклоняться нельзя):',
    topic.trim() || 'Компания продаёт товары и услуги.',
    '',
    'ТВОЙ ОБРАЗ:',
    personaBlock(persona),
    '',
    'ПРАВИЛА:',
    ironRules(),
    '',
    'Напиши только текст первого сообщения. Оно должно звучать как настоящий первый запрос от этого человека по теме компании: естественно, коротко, в его манере. Не представляйся по имени без нужды. Не пиши «здравствуйте, меня интересует ваша услуга» шаблонно.',
  ].join('\n')
  const user =
    'Сгенерируй первое сообщение клиента. Верни только текст сообщения, без пояснений.'
  return callGateway(system, user, model?.trim() || MODEL, 1.0)
}

/**
 * Очередная реплика «клиента» в ответ на менеджера. Ведёт диалог в характере
 * персоны: реагирует, торгуется, уточняет, соглашается или отказывается.
 */
export async function generateClientReply(
  topic: string,
  persona: AutopilotPersona,
  history: AutopilotTurn[],
  turnsSoFar: number,
  maxTurns: number,
  model: string | null,
): Promise<string | null> {
  const nearingEnd = turnsSoFar >= maxTurns - 2
  const system = [
    'Ты — клиент, который ведёт переписку с менеджером компании. Отвечай на его последнее сообщение, оставаясь собой.',
    '',
    'ТЕМАТИКА КОМПАНИИ (это ЗАКОН, отклоняться нельзя):',
    topic.trim() || 'Компания продаёт товары и услуги.',
    '',
    'ТВОЙ ОБРАЗ:',
    personaBlock(persona),
    '',
    'ПРАВИЛА:',
    ironRules(),
    '',
    nearingEnd
      ? 'Диалог подходит к концу. Веди к естественному завершению: либо мягко соглашайся на следующий шаг, либо вежливо возьми паузу подумать, либо откажись если не убедили. Не обрывай грубо.'
      : 'Реагируй живо и по делу: уточняй, сомневайся, торгуйся, задавай встречные вопросы в своём характере. Не соглашайся слишком легко.',
  ].join('\n')

  const dialogue = history
    .map((t) => `${t.role === 'client' ? 'Я' : 'Менеджер'}: ${t.body}`)
    .join('\n')
  const user = [
    'Переписка (Я — это ты, клиент):',
    dialogue,
    '',
    'Напиши мою следующую реплику одним сообщением. Только текст, без пояснений.',
  ].join('\n')

  return callGateway(system, user, model?.trim() || MODEL, 0.95)
}
