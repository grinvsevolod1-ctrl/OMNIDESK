/**
 * Media understanding (vision + STT): turn client photos and voice notes into
 * text the brain can reason about. Same dependency rules as the rest of
 * lib/ai/brain/ (see core.ts).
 */

import { GATEWAY_URL, type BrainLog, type GatewayResponse } from './core.js'

const TRANSCRIPTION_URL = 'https://ai-gateway.vercel.sh/v1/audio/transcriptions'

// A multimodal model reads the client's photos (passport, receipt, screenshot…)
// so the manager reacts to what was actually sent, not a blind "[Фото]".
const VISION_MODEL = process.env.MANAGER_AI_VISION_MODEL || 'openai/gpt-4.1-mini'
// Speech-to-text for voice notes / audio. whisper-1 is cheap and solid on RU.
const TRANSCRIBE_MODEL =
  process.env.MANAGER_AI_TRANSCRIBE_MODEL || 'openai/whisper-1'

// Guards so we never ship an oversized payload to the gateway. Images are
// resized-on-send by the model, but we still cap the upload; whisper's own
// hard limit is 25MB.
const VISION_MAX_BYTES = 8 * 1024 * 1024
const TRANSCRIBE_MAX_BYTES = 24 * 1024 * 1024

/** The media kinds the brain can turn into text. Others keep a placeholder. */
export type UnderstandableMedia = 'image' | 'voice' | 'audio'

/** Map an arbitrary media_type to an understandable kind, or null. */
export function understandableMediaKind(
  mediaType: string | null | undefined,
): UnderstandableMedia | null {
  if (mediaType === 'image') return 'image'
  if (mediaType === 'voice') return 'voice'
  if (mediaType === 'audio') return 'audio'
  return null
}

/**
 * Describe an image the client sent, in one short Russian sentence, focused on
 * what matters for a sales/onboarding chat (documents, IDs, receipts, defects,
 * screenshots). Returns null on any failure so the caller degrades to a
 * placeholder rather than breaking the reply.
 */
export async function describeImage(
  bytes: Buffer,
  mime: string | null,
  log?: BrainLog,
): Promise<string | null> {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key || bytes.byteLength === 0 || bytes.byteLength > VISION_MAX_BYTES) {
    return null
  }
  const dataUrl = `data:${mime || 'image/jpeg'};base64,${bytes.toString('base64')}`
  try {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Ты помогаешь менеджеру понять, что клиент прислал на фото. Опиши изображение ОДНИМ коротким предложением на русском. Если это документ (паспорт, права, СНИЛС, ИНН, трудовая, договор, чек, справка) — прямо назови тип документа и ключевые видимые поля, не выдумывая данные. Если это скриншот переписки/оплаты — скажи это. Без вступлений, только суть.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Что на этом изображении?' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0.2,
        max_tokens: 160,
      }),
    })
    if (!res.ok) {
      log?.({
        level: 'warn',
        event: 'vision.http_error',
        message: `Не удалось распознать фото (HTTP ${res.status}).`,
      })
      return null
    }
    const data = (await res.json()) as GatewayResponse
    const text = data.choices?.[0]?.message?.content?.trim()
    return text ? text.replace(/\s+/g, ' ').slice(0, 400) : null
  } catch (err) {
    log?.({
      level: 'warn',
      event: 'vision.exception',
      message: `Ошибка распознавания фото: ${err instanceof Error ? err.message : String(err)}`,
    })
    return null
  }
}

/**
 * Transcribe a voice note / audio message to Russian text via the gateway's
 * OpenAI-compatible transcription endpoint. Returns null on any failure.
 */
export async function transcribeAudio(
  bytes: Buffer,
  mime: string | null,
  name: string | null,
  log?: BrainLog,
): Promise<string | null> {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key || bytes.byteLength === 0 || bytes.byteLength > TRANSCRIBE_MAX_BYTES) {
    return null
  }
  try {
    const form = new FormData()
    const fileName = name || (mime?.includes('mpeg') ? 'audio.mp3' : 'audio.ogg')
    // Uint8Array view keeps this dependency-free and works under Node 18+ in
    // both the Next.js runtime and the worker (tsx).
    const blob = new Blob([new Uint8Array(bytes)], {
      type: mime || 'audio/ogg',
    })
    form.append('file', blob, fileName)
    form.append('model', TRANSCRIBE_MODEL)
    form.append('language', 'ru')
    const res = await fetch(TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    })
    if (!res.ok) {
      log?.({
        level: 'warn',
        event: 'stt.http_error',
        message: `Не удалось расшифровать аудио (HTTP ${res.status}).`,
      })
      return null
    }
    const data = (await res.json()) as { text?: string }
    const text = data.text?.trim()
    return text ? text.replace(/\s+/g, ' ').slice(0, 1200) : null
  } catch (err) {
    log?.({
      level: 'warn',
      event: 'stt.exception',
      message: `Ошибка расшифровки аудио: ${err instanceof Error ? err.message : String(err)}`,
    })
    return null
  }
}

/**
 * Turn one media message into a compact text stand-in the brain can reason
 * about, e.g. «[Фото: паспорт РФ, разворот с фамилией]» or «[Голосовое,
 * расшифровка: "перезвоните после обеда"]». Returns null when the kind isn't
 * understandable or analysis failed, so the caller falls back to a placeholder.
 * The bytes are provided lazily so we only pull them from the DB when needed.
 */
export async function understandMedia(
  params: {
    mediaType: string | null
    loadBytes: () => Promise<{
      bytes: Buffer
      mime: string | null
      name: string | null
    } | null>
  },
  log?: BrainLog,
): Promise<string | null> {
  const kind = understandableMediaKind(params.mediaType)
  if (!kind) return null
  const media = await params.loadBytes()
  if (!media) return null

  if (kind === 'image') {
    const desc = await describeImage(media.bytes, media.mime, log)
    return desc ? `[Фото: ${desc}]` : null
  }
  // voice / audio
  const transcript = await transcribeAudio(
    media.bytes,
    media.mime,
    media.name,
    log,
  )
  if (!transcript) return null
  return kind === 'voice'
    ? `[Голосовое сообщение, расшифровка: "${transcript}"]`
    : `[Аудио, расшифровка: "${transcript}"]`
}
