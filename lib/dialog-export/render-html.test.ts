/**
 * Тесты выгрузки диалога в HTML: порядок и атрибуция сообщений, даты/время
 * в МСК, экранирование, вложения (ссылки на файлы архива / плашки), а также
 * имена файлов выгрузки.
 */
import { describe, expect, it } from 'vitest'
import type { Message } from '@/lib/types'
import { escapeHtml, renderDialogHtml } from './render-html'
import { dialogExportFilename } from './naming'
import type { DialogExportPayload } from './types'

function msg(over: Partial<Message> & Pick<Message, 'id' | 'createdAt'>): Message {
  return {
    conversationId: 'conv-1',
    direction: 'in',
    body: '',
    author: 'Кандидат',
    ...over,
  }
}

function payload(messages: Message[], over: Partial<DialogExportPayload> = {}): DialogExportPayload {
  return {
    conversation: {
      id: 'conv-1',
      contactName: 'Иван <Петров>',
      contactUsername: 'ivan',
      contactHandle: '12345',
      channelType: 'telegram',
      channelName: null,
      curatorName: 'Мария',
      managerName: 'Олег',
      transferredToCuratorAt: '2026-09-20T09:00:00.000Z',
    },
    messages,
    truncated: false,
    exportedAt: '2026-09-24T10:00:00.000Z',
    exportedBy: { name: 'Мария', role: 'curator' },
    ...over,
  }
}

const noMedia = { mediaPath: () => null, mediaOmitted: true }

describe('renderDialogHtml', () => {
  it('сохраняет порядок сообщений, отправителя, дату и время (МСК)', () => {
    const html = renderDialogHtml(
      payload([
        // 21:30 UTC 23.09 = 00:30 МСК 24.09 — разделитель дня должен быть по Москве.
        msg({ id: 'a', createdAt: '2026-09-23T21:30:00.000Z', body: 'Здравствуйте' }),
        msg({
          id: 'b',
          createdAt: '2026-09-24T06:05:00.000Z',
          direction: 'out',
          author: 'Мария',
          body: 'Добрый день!',
        }),
      ]),
      noMedia,
    )
    const a = html.indexOf('id="m-a"')
    const b = html.indexOf('id="m-b"')
    expect(a).toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a)
    // Оба сообщения — в один московский день, разделитель ровно один.
    expect(html.match(/class="day"/g)?.length).toBe(1)
    expect(html).toContain('24 сент. 2026')
    expect(html).toContain('>00:30<')
    expect(html).toContain('>09:05<')
    expect(html).toContain('class="msg in"')
    expect(html).toContain('class="msg out"')
    expect(html).toContain('<span class="author">Мария</span>')
  })

  it('экранирует HTML в имени контакта и теле сообщения', () => {
    const html = renderDialogHtml(
      payload([
        msg({
          id: 'x',
          createdAt: '2026-09-24T06:00:00.000Z',
          body: '<script>alert(1)</script> & "кавычки"',
        }),
      ]),
      noMedia,
    )
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;кавычки&quot;')
    expect(html).toContain('Диалог с Иван &lt;Петров&gt;')
  })

  it('ссылается на файлы архива, когда медиа вложено, и ставит плашку, когда нет', () => {
    const photo = msg({
      id: 'p1',
      createdAt: '2026-09-24T06:00:00.000Z',
      body: '[Фото]',
      mediaType: 'image',
      mediaMime: 'image/jpeg',
      mediaUrl: '/api/media/p1',
    })
    const voice = msg({
      id: 'v1',
      createdAt: '2026-09-24T06:01:00.000Z',
      body: '[Голосовое сообщение]',
      mediaType: 'voice',
      mediaMime: 'audio/ogg',
      mediaUrl: '/api/media/v1',
    })
    const doc = msg({
      id: 'd1',
      createdAt: '2026-09-24T06:02:00.000Z',
      body: '[Файл: резюме.pdf]',
      mediaType: 'document',
      mediaName: 'резюме.pdf',
      mediaUrl: '/api/media/d1',
    })
    const withMedia = renderDialogHtml(payload([photo, voice, doc]), {
      mediaPath: (m) =>
        m.id === 'p1'
          ? 'media/001-photo-p1.jpg'
          : m.id === 'v1'
            ? 'media/002-media-v1.ogg'
            : null, // документ «не скачался»
      mediaOmitted: false,
    })
    expect(withMedia).toContain('<img src="media/001-photo-p1.jpg"')
    expect(withMedia).toContain('<audio controls preload="metadata" src="media/002-media-v1.ogg">')
    expect(withMedia).toContain('файл не удалось выгрузить')
    expect(withMedia).toContain('Вложено файлов: 2 из 3')
    // Плейсхолдер «[Фото]» не дублируется текстом под картинкой.
    expect(withMedia).not.toContain('<div class="body">[Фото]</div>')

    const omitted = renderDialogHtml(payload([photo]), noMedia)
    expect(omitted).toContain('не вложено в выгрузку')
    expect(omitted).toContain('Вложения (1) не включены в выгрузку по выбору.')
    expect(omitted).not.toContain('<img')
  })

  it('помечает удалённые и изменённые сообщения, цитаты и реакции', () => {
    const html = renderDialogHtml(
      payload([
        msg({
          id: 'q',
          createdAt: '2026-09-24T06:00:00.000Z',
          body: 'Ответ',
          replyTo: { id: 'orig', author: 'Мария', body: 'Вопрос?' },
          reactions: [{ emoji: '👍', fromMe: true }],
          editedAt: '2026-09-24T06:10:00.000Z',
          deletedAt: '2026-09-24T06:20:00.000Z',
          deletedOrigin: 'remote',
        }),
      ]),
      noMedia,
    )
    expect(html).toContain('class="msg in deleted"')
    expect(html).toContain('удалено собеседником')
    expect(html).toContain('<span class="flag">изменено</span>')
    expect(html).toContain('<span class="reply-author">Мария</span><span class="reply-text">Вопрос?</span>')
    expect(html).toContain('<span class="reaction">👍</span>')
  })

  it('пустая история и обрезка по лимиту отражены в шапке', () => {
    const html = renderDialogHtml(payload([], { truncated: true }), noMedia)
    expect(html).toContain('Сообщений нет.')
    expect(html).toContain('История длиннее лимита выгрузки')
    expect(html).toContain('<dt>Менеджер по кадрам</dt><dd>Мария</dd>')
    expect(html).toContain('<dt>Передал</dt><dd>Олег</dd>')
  })

  it('не содержит скриптов и внешних ресурсов', () => {
    const html = renderDialogHtml(
      payload([msg({ id: 'a', createdAt: '2026-09-24T06:00:00.000Z', body: 'см. https://example.com/x?a=1' })]),
      noMedia,
    )
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<link /i)
    // Ссылки в тексте кликабельны, но экранированы.
    expect(html).toContain('<a href="https://example.com/x?a=1" rel="noopener noreferrer" target="_blank">')
  })
})

describe('escapeHtml', () => {
  it('экранирует пять спецсимволов', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    )
  })
})

describe('dialogExportFilename', () => {
  const at = new Date('2026-09-24T10:00:00.000Z')
  it('чистит имя контакта и ставит дату', () => {
    expect(dialogExportFilename('Иван Петров / "тест"', 'zip', at)).toBe(
      'dialog-Иван-Петров-тест-2026-09-24.zip',
    )
    expect(dialogExportFilename(undefined, 'html', at)).toBe('dialog-2026-09-24.html')
  })
})
