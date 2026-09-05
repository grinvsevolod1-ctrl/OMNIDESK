import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { env } from './env.js'
import { logger } from './logger.js'
import { registry } from './registry.js'
import { TelegramSession } from './telegram.js'
import { probeProxy } from './proxy.js'
import * as repo from './repo.js'

/**
 * Tiny internal HTTP API consumed only by the panel (same host, protected by a
 * shared WORKER_SECRET). It streams Telegram media/stickers, runs proxy checks
 * and exposes a health check. All stateful commands go through the job queue.
 */
export function startHttpServer(): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${env.workerPort}`)

    // Health is unauthenticated for pm2/uptime checks.
    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, ts: Date.now() })
    }

    // Everything else requires the shared secret (constant-time comparison).
    const provided = req.headers['x-worker-secret']
    if (typeof provided !== 'string' || !secretMatches(provided, env.workerSecret)) {
      return json(res, 401, { error: 'unauthorized' })
    }

    // Live Telegram QR-login deep link for a channel (held in worker memory
    // while a QR login is pending — never persisted). The panel polls this
    // and renders the QR for the account owner to scan.
    if (url.pathname === '/qr' && req.method === 'GET') {
      const channelId = url.searchParams.get('channelId') ?? ''
      if (!channelId) return json(res, 400, { error: 'channelId required' })
      const session = registry.get(channelId)
      if (!session) return json(res, 200, { qr: null, expiresAt: null })
      if (!(session instanceof TelegramSession)) {
        return json(res, 415, { error: 'unsupported_channel' })
      }
      const qr = session.getQr()
      return json(res, 200, {
        qr: qr?.url ?? null,
        expiresAt: qr?.expiresAt ?? null,
      })
    }

    // Stream a message's media. The panel proxies the browser request here
    // after verifying ownership. We serve the bytes PERSISTED in Postgres first
    // (so media survives the contact deleting/editing the original); only when
    // nothing was stored do we fall back to a live re-download from the provider.
    if (url.pathname === '/media' && req.method === 'GET') {
      const messageId = url.searchParams.get('messageId') ?? ''
      const editId = url.searchParams.get('edit') ?? ''

      // Historical (pre-edit) version of the media, addressed by edit id.
      if (editId) {
        const stored = await repo.getStoredEditMediaBytes(editId)
        if (!stored) return json(res, 410, { error: 'media_unavailable' })
        res.writeHead(200, {
          'content-type': stored.mime || 'application/octet-stream',
          'content-length': String(stored.bytes.byteLength),
          'cache-control': 'private, max-age=31536000, immutable',
        })
        res.end(stored.bytes)
        return
      }

      // Current version: prefer durably stored bytes.
      const storedNow = await repo.getStoredMediaBytes(messageId)
      if (storedNow) {
        const headers: Record<string, string> = {
          'content-type': storedNow.mime || 'application/octet-stream',
          'content-length': String(storedNow.bytes.byteLength),
          'cache-control': 'private, max-age=31536000, immutable',
        }
        res.writeHead(200, headers)
        res.end(storedNow.bytes)
        return
      }

      const info = await repo.getMessageMedia(messageId)
      if (!info || !info.mediaType) {
        return json(res, 404, { error: 'media_not_found' })
      }
      const session = registry.get(info.channelId)
      if (!session) {
        return json(res, 503, { error: 'session_offline' })
      }
      if (typeof (session as { downloadMedia?: unknown }).downloadMedia !== 'function') {
        return json(res, 415, { error: 'unsupported_channel' })
      }
      // Outbound media (photo/voice/sticker we sent from the panel) is recorded
      // with media_ref = NULL — only provider_message_id is backfilled after the
      // send. Reconstruct the { peer, msgId } descriptor the downloader expects
      // from the conversation's contact_handle + provider id so those bubbles
      // re-download just like inbound ones. Inbound rows keep their stored ref.
      const downloadRef =
        info.mediaRef ??
        (info.providerMessageId && info.contactHandle
          ? { peer: info.contactHandle, msgId: info.providerMessageId }
          : null)
      if (!downloadRef) {
        return json(res, 410, { error: 'media_unavailable' })
      }
      let media: { buffer: Buffer; mime: string | null; name: string | null } | null
      try {
        media = await (
          session as {
            downloadMedia: (
              ref: unknown,
            ) => Promise<{ buffer: Buffer; mime: string | null; name: string | null } | null>
          }
        ).downloadMedia(downloadRef)
      } catch (err) {
        logger.warn({ err, messageId }, 'media download failed')
        return json(res, 410, { error: 'media_unavailable' })
      }
      if (!media) {
        return json(res, 410, { error: 'media_unavailable' })
      }
      const mime = media.mime || info.mediaMime || 'application/octet-stream'
      const headers: Record<string, string> = {
        'content-type': mime,
        'content-length': String(media.buffer.byteLength),
        'cache-control': 'private, max-age=86400',
      }
      const fileName = media.name || info.mediaName
      if (info.mediaType === 'document' && fileName) {
        headers['content-disposition'] =
          `attachment; filename="${encodeURIComponent(fileName)}"`
      }
      res.writeHead(200, headers)
      res.end(media.buffer)
      return
    }

    // List stickers (favourited + recent) for a Telegram channel.
    if (url.pathname === '/stickers' && req.method === 'GET') {
      const channelId = url.searchParams.get('channelId') ?? ''
      const session = registry.get(channelId)
      if (!session) return json(res, 503, { error: 'session_offline' })
      if (!(session instanceof TelegramSession)) {
        return json(res, 415, { error: 'unsupported_channel' })
      }
      try {
        const stickers = await session.listStickers()
        return json(res, 200, { stickers })
      } catch (err) {
        logger.warn({ err, channelId }, 'list stickers failed')
        return json(res, 502, { error: 'stickers_unavailable' })
      }
    }

    // Stream a sticker thumbnail/preview for a Telegram channel.
    if (url.pathname === '/sticker-thumb' && req.method === 'GET') {
      const channelId = url.searchParams.get('channelId') ?? ''
      const id = url.searchParams.get('id') ?? ''
      const accessHash = url.searchParams.get('accessHash') ?? ''
      const fileReference = url.searchParams.get('fileReference') ?? ''
      const session = registry.get(channelId)
      if (!session) return json(res, 503, { error: 'session_offline' })
      if (!(session instanceof TelegramSession)) {
        return json(res, 415, { error: 'unsupported_channel' })
      }
      try {
        const thumb = await session.downloadStickerById({ id, accessHash, fileReference })
        if (!thumb) return json(res, 410, { error: 'sticker_unavailable' })
        res.writeHead(200, {
          'content-type': thumb.mime,
          'content-length': String(thumb.buffer.byteLength),
          'cache-control': 'private, max-age=86400',
        })
        res.end(thumb.buffer)
        return
      } catch (err) {
        logger.warn({ err, channelId }, 'sticker thumb failed')
        return json(res, 502, { error: 'sticker_unavailable' })
      }
    }

    // ------------------------------------------------------------------
    // Personal Telegram (god-панель). Живые read/send операции для личных
    // аккаунтов (type='telegram_personal'): переписка НИКОГДА не пишется в
    // Postgres — всё читается из Telegram на лету (worker/src/personal.ts).
    // Скоуп: сессия должна существовать И быть personal, иначе 404/415.
    // ------------------------------------------------------------------
    if (url.pathname.startsWith('/personal/')) {
      // GET-эндпоинты несут channelId в query, POST-эндпоинты (send/edit/
      // delete/read) — в JSON-теле. Тело читается ОДИН раз здесь, до гейта:
      // раньше гейт смотрел только в query, для POST получал '' и ВСЕГДА
      // отвечал session_offline — отправка не работала, хотя чтение работало.
      let body: Record<string, unknown> = {}
      if (req.method === 'POST') {
        try {
          body = await readJsonBody(req)
        } catch {
          return json(res, 413, { error: 'body_too_large' })
        }
      }
      const channelId =
        url.searchParams.get('channelId') || String(body.channelId ?? '')
      const session = registry.get(channelId)
      if (!session || !(session instanceof TelegramSession)) {
        return json(res, 503, { error: 'session_offline' })
      }
      if (!session.personal) return json(res, 415, { error: 'unsupported_channel' })

      try {
        // Список диалогов аккаунта (живой снапшот).
        if (url.pathname === '/personal/dialogs' && req.method === 'GET') {
          const limit = Number(url.searchParams.get('limit') ?? 50)
          const dialogs = await session.personalDialogs(
            Math.min(Math.max(1, limit), 100),
          )
          return json(res, 200, { dialogs })
        }

        // Страница истории одного диалога (beforeId — пагинация назад).
        if (url.pathname === '/personal/history' && req.method === 'GET') {
          const peer = url.searchParams.get('peer') ?? ''
          if (!peer) return json(res, 400, { error: 'peer required' })
          const beforeId = Number(url.searchParams.get('beforeId') ?? 0)
          const limit = Number(url.searchParams.get('limit') ?? 40)
          const messages = await session.personalHistory(peer, {
            beforeId: beforeId > 0 ? beforeId : undefined,
            limit: Math.min(Math.max(1, limit), 100),
          })
          return json(res, 200, { messages })
        }

        // Аватар собеседника.
        if (url.pathname === '/personal/avatar' && req.method === 'GET') {
          const peer = url.searchParams.get('peer') ?? ''
          if (!peer) return json(res, 400, { error: 'peer required' })
          const avatar = await session.personalAvatar(peer)
          if (!avatar) return json(res, 404, { error: 'no_avatar' })
          res.writeHead(200, {
            'content-type': 'image/jpeg',
            'content-length': String(avatar.byteLength),
            'cache-control': 'private, max-age=3600',
          })
          res.end(avatar)
          return
        }

        // Медиа одного сообщения (фото/войс/документ) — стрим без записи.
        if (url.pathname === '/personal/media' && req.method === 'GET') {
          const peer = url.searchParams.get('peer') ?? ''
          const messageId = Number(url.searchParams.get('messageId') ?? 0)
          if (!peer || !messageId) {
            return json(res, 400, { error: 'peer and messageId required' })
          }
          const media = await session.personalMedia(peer, messageId)
          if (!media) return json(res, 410, { error: 'media_unavailable' })
          const headers: Record<string, string> = {
            'content-type': media.mime,
            'content-length': String(media.buffer.byteLength),
            'cache-control': 'private, max-age=86400',
          }
          if (media.name) {
            headers['content-disposition'] =
              `inline; filename="${encodeURIComponent(media.name)}"`
          }
          res.writeHead(200, headers)
          res.end(media.buffer)
          return
        }

        // Отправка текста (+опц. reply). Живой send, результат сразу.
        if (url.pathname === '/personal/send' && req.method === 'POST') {
          const peer = String(body.peer ?? '')
          const text = String(body.text ?? '')
          if (!peer || !text) return json(res, 400, { error: 'peer and text required' })
          const replyToMsgId = body.replyToMsgId ? Number(body.replyToMsgId) : undefined
          const result = await session.sendMessage(
            peer,
            text,
            replyToMsgId ? { replyToMsgId } : undefined,
          )
          return json(res, 200, {
            sent: true,
            providerMessageId: result?.providerMessageId ?? null,
          })
        }

        // Отправка файла/фото (base64, панель ограничивает размер).
        if (url.pathname === '/personal/send-file' && req.method === 'POST') {
          const peer = String(body.peer ?? '')
          const dataB64 = String(body.data ?? '')
          if (!peer || !dataB64) return json(res, 400, { error: 'peer and data required' })
          const result = await session.personalSendFile(peer, {
            buffer: Buffer.from(dataB64, 'base64'),
            name: String(body.name ?? 'file'),
            mime: body.mime ? String(body.mime) : null,
            asPhoto: Boolean(body.asPhoto),
            caption: body.caption ? String(body.caption) : undefined,
            replyToMsgId: body.replyToMsgId ? Number(body.replyToMsgId) : undefined,
          })
          return json(res, 200, {
            sent: true,
            providerMessageId: result?.providerMessageId ?? null,
          })
        }

        // Голосовое сообщение (нативный voice bubble).
        if (url.pathname === '/personal/send-voice' && req.method === 'POST') {
          const peer = String(body.peer ?? '')
          const audioB64 = String(body.audio ?? '')
          if (!peer || !audioB64) return json(res, 400, { error: 'peer and audio required' })
          const result = await session.sendVoice(peer, {
            buffer: Buffer.from(audioB64, 'base64'),
            durationSec: Number(body.durationSec ?? 0),
          })
          return json(res, 200, {
            sent: true,
            providerMessageId: result?.providerMessageId ?? null,
          })
        }

        // Редактирование своего текстового сообщения.
        if (url.pathname === '/personal/edit' && req.method === 'POST') {
          const peer = String(body.peer ?? '')
          const messageId = Number(body.messageId ?? 0)
          const text = String(body.text ?? '')
          if (!peer || !messageId || !text) {
            return json(res, 400, { error: 'peer, messageId and text required' })
          }
          await session.editMessage(peer, messageId, text)
          return json(res, 200, { edited: true })
        }

        // Удаление сообщения (у всех).
        if (url.pathname === '/personal/delete' && req.method === 'POST') {
          const peer = String(body.peer ?? '')
          const messageId = Number(body.messageId ?? 0)
          if (!peer || !messageId) {
            return json(res, 400, { error: 'peer and messageId required' })
          }
          await session.deleteMessage(peer, messageId, true)
          return json(res, 200, { deleted: true })
        }

        // Удаление всего диалога (revoke — также у собеседника; каналы и
        // супергруппы покидаются вместо удаления).
        if (url.pathname === '/personal/delete-dialog' && req.method === 'POST') {
          const peer = String(body.peer ?? '')
          if (!peer) return json(res, 400, { error: 'peer required' })
          await session.personalDeleteDialog(peer, Boolean(body.revoke))
          return json(res, 200, { deleted: true })
        }

        // Отметить диалог прочитанным.
        if (url.pathname === '/personal/read' && req.method === 'POST') {
          const peer = String(body.peer ?? '')
          if (!peer) return json(res, 400, { error: 'peer required' })
          await session.markRead(peer).catch(() => {})
          return json(res, 200, { read: true })
        }

        // Собственный профиль аккаунта (имя/фамилия/@username/телефон).
        if (url.pathname === '/personal/profile' && req.method === 'GET') {
          const profile = await session.personalProfile()
          return json(res, 200, { profile })
        }

        // Изменить имя/фамилию/«о себе» в самом Telegram.
        if (url.pathname === '/personal/profile' && req.method === 'POST') {
          await session.personalUpdateProfile({
            firstName:
              body.firstName != null ? String(body.firstName) : undefined,
            lastName: body.lastName != null ? String(body.lastName) : undefined,
            about: body.about != null ? String(body.about) : undefined,
          })
          return json(res, 200, { updated: true })
        }

        // Изменить @username (пустая строка снимает username).
        if (url.pathname === '/personal/username' && req.method === 'POST') {
          await session.personalSetUsername(String(body.username ?? ''))
          return json(res, 200, { updated: true })
        }

        // Написать первым новому собеседнику (@username или телефон).
        if (url.pathname === '/personal/start-dialog' && req.method === 'POST') {
          const target = String(body.target ?? '')
          const text = String(body.text ?? '')
          if (!target || !text) {
            return json(res, 400, { error: 'target and text required' })
          }
          const result = await session.personalStartDialog(target, text)
          return json(res, 200, { started: true, ...result })
        }

        return json(res, 404, { error: 'not_found' })
      } catch (err) {
        logger.warn(
          { err, channelId, path: url.pathname },
          'personal endpoint failed',
        )
        return json(res, 502, {
          error: err instanceof Error ? err.message : 'personal_failed',
        })
      }
    }

    if (url.pathname === '/proxy-check' && req.method === 'GET') {
      const proxyId = url.searchParams.get('proxyId') ?? ''
      const config = await repo.getProxyById(proxyId)
      if (!config) return json(res, 404, { ok: false, error: 'Proxy not found' })
      const result = await probeProxy(config)
      await repo
        .markProxy(
          proxyId,
          result.ok ? 'ok' : 'error',
          result.error ?? null,
          result.ok ? (result.latencyMs ?? null) : null,
        )
        .catch(() => {})
      return json(res, 200, result)
    }

    return json(res, 404, { error: 'not_found' })
  })

  server.listen(env.workerPort, '127.0.0.1', () => {
    logger.info(`Worker HTTP API on http://127.0.0.1:${env.workerPort}`)
  })
}

/**
 * Read and parse a JSON request body, capped at 24 MB (голосовые ~1 МБ,
 * фото/файлы панель режет до ~16 МБ base64). Отказ раньше лимита — защита
 * от случайного OOM на внутреннем API.
 */
async function readJsonBody(
  req: import('node:http').IncomingMessage,
): Promise<Record<string, unknown>> {
  const MAX = 24 * 1024 * 1024
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.byteLength
    if (size > MAX) throw new Error('body_too_large')
    chunks.push(buf)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    throw new Error('invalid_json')
  }
}

/** Constant-time secret comparison (hash both sides to equalize length). */
function secretMatches(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

function json(
  res: import('node:http').ServerResponse,
  status: number,
  body: unknown,
): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
  })
  res.end(data)
}
