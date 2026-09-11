import { logger } from './logger.js'

/**
 * Worker-side per-group text variation, the runner's fallback when a target has
 * no pre-generated variant (the panel normally generates them at review time).
 *
 * The worker has no `ai` SDK — it calls the Vercel AI Gateway over fetch, just
 * like hosting/gateway.ts. If the gateway isn't configured or fails, a
 * DETERMINISTIC offline variation keeps the broadcast flowing while still
 * avoiding byte-identical messages (which anti-spam filters drop).
 *
 * Kept in sync with lib/broadcast/draft.ts (panel side); the offline logic is
 * intentionally identical so online and offline paths behave the same.
 */

const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/chat/completions'
const BROADCAST_MODEL = process.env.BROADCAST_MODEL || 'openai/gpt-4.1-mini'
const MAX_LEN = 600

/** Unique per-group variant of the base post. Never throws. */
export async function varyForGroup(
  base: string,
  groupTitle: string,
): Promise<string> {
  const trimmed = base.trim()
  if (!trimmed) return ''

  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) return offlineVariant(trimmed, groupTitle)

  try {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: BROADCAST_MODEL,
        temperature: 0.9,
        max_tokens: 400,
        messages: [
          {
            role: 'system',
            content:
              'Перепиши объявление другими словами, сохранив смысл и предложение. ' +
              'Измени формулировки, порядок предложений и часть лексики так, чтобы ' +
              'текст заметно отличался от оригинала (обход антиспам-фильтров на ' +
              'одинаковые сообщения). По-русски, живо, без markdown и хэштегов, ' +
              'максимум один эмодзи. Верни ТОЛЬКО новый текст.',
          },
          {
            role: 'user',
            content: `Аудитория группы: «${groupTitle}».\nОригинал объявления:\n${trimmed}`,
          },
        ],
      }),
    })
    if (!res.ok) return offlineVariant(trimmed, groupTitle)
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>
    }
    const text = data.choices?.[0]?.message?.content?.trim() ?? ''
    return clamp(text) || offlineVariant(trimmed, groupTitle)
  } catch (err) {
    logger.warn({ err: String(err) }, 'broadcast: variant generation failed')
    return offlineVariant(trimmed, groupTitle)
  }
}

/* --------------------------- Deterministic fallback -------------------------- */

function clamp(text: string): string {
  const oneSpace = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (oneSpace.length <= MAX_LEN) return oneSpace
  const slice = oneSpace.slice(0, MAX_LEN)
  const lastStop = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  )
  return (lastStop > MAX_LEN * 0.5 ? slice.slice(0, lastStop + 1) : slice).trim()
}

const OPENERS = [
  'Всем привет!',
  'Доброго дня!',
  'Привет всем в чате.',
  'Здравствуйте!',
  'Добрый день, коллеги.',
  'Приветствую!',
]

function offlineVariant(base: string, groupTitle: string): string {
  const idx = hashString(groupTitle) % OPENERS.length
  const opener = OPENERS[idx]
  const body = base.replace(
    /^(всем привет|доброго дня|привет всем[^.!?]*|здравствуйте|добрый день[^.!?]*|приветствую)[.!,]?\s*/i,
    '',
  )
  return clamp(`${opener} ${body}`)
}

function hashString(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}
