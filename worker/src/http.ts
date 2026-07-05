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

    // Stream a message's media. The panel proxies the browser request here
    // after verifying ownership; the worker re-downloads from the provider.
    if (url.pathname === '/media' && req.method === 'GET') {
      const messageId = url.searchParams.get('messageId') ?? ''
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
      let media: { buffer: Buffer; mime: string | null; name: string | null } | null
      try {
        media = await (
          session as {
            downloadMedia: (
              ref: unknown,
            ) => Promise<{ buffer: Buffer; mime: string | null; name: string | null } | null>
          }
        ).downloadMedia(info.mediaRef)
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

    if (url.pathname === '/proxy-check' && req.method === 'GET') {
      const proxyId = url.searchParams.get('proxyId') ?? ''
      const config = await repo.getProxyById(proxyId)
      if (!config) return json(res, 404, { ok: false, error: 'Proxy not found' })
      const result = await probeProxy(config)
      await repo
        .markProxy(proxyId, result.ok ? 'ok' : 'error', result.error ?? null)
        .catch(() => {})
      return json(res, 200, result)
    }

    return json(res, 404, { error: 'not_found' })
  })

  server.listen(env.workerPort, '127.0.0.1', () => {
    logger.info(`Worker HTTP API on http://127.0.0.1:${env.workerPort}`)
  })
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
