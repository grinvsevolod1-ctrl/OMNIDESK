'use client'

import { useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import {
  CircleDot,
  ImageIcon,
  Loader2,
  Paperclip,
  Play,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  deleteLeadAttachmentAction,
  type LeadAttachmentView,
} from '@/app/actions/lead-cards'
import { Button } from '@/components/ui/button'
import { VideoNotePlayer } from '@/components/shared/video-note-player'
import { compressImageFile } from '@/lib/compress-image'
import { formatMskDateTime as formatDateTime } from '@/lib/time'
import { cn } from '@/lib/utils'

const MAX_FILES = 10
const MAX_BYTES = 50 * 1024 * 1024

const ROLE_LABEL: Record<string, string> = {
  manager: 'менеджер',
  curator: 'менеджер по кадрам',
  admin: 'админ',
  head: 'руководитель',
}

/**
 * Вложения карточки лида: сетка фото/видео/кружков + загрузка файлов и
 * (для менеджера в контексте диалога) закрепление телеграм-кружка.
 * Виден всем, у кого есть доступ к карточке; удалять может автор и админ.
 */
export function LeadAttachments({
  leadCardId,
  ensureCardId,
  conversationId,
  attachments,
  onChanged,
  onBrowseMedia,
  readOnly = false,
  }: {
  /** null — карточка ещё не сохранена (см. ensureCardId). */
  leadCardId: string | null
  /**
   * Ленивая инициализация карточки: вызывается перед первым прикреплением,
   * когда карточка ещё не сохранена. Возвращает id или null при ошибке.
   */
  ensureCardId?: () => Promise<string | null>
  /** Диалог карточки — включает кнопку «Прикрепить кружок». */
  conversationId?: string | null
  attachments: LeadAttachmentView[]
  onChanged: (next: LeadAttachmentView[]) => void
  /**
   * Телеграм-стиль выбор медиа из диалога: кнопки «Кружок»/«Фото» открывают
   * навигацию по треду вместо старого выпадающего списка.
   */
  onBrowseMedia?: (kind: 'video_note' | 'photo') => void
  /** Просмотр без загрузки (руководитель с правом «только просмотр»). */
  readOnly?: boolean
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [pending, startTransition] = useTransition()
  const [viewer, setViewer] = useState<LeadAttachmentView | null>(null)
  /**
   * Режим «просмотр перед удалением»: клик по корзине не удаляет сразу, а
   * открывает полноэкранный просмотр с панелью подтверждения — можно ещё раз
   * посмотреть кружок/видео/фото и только потом подтвердить удаление.
   */
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  function onFilesPicked(list: FileList | null) {
    if (!list || list.length === 0) return
    const files = Array.from(list)
    if (files.length > MAX_FILES) {
      toast.error(`За раз можно до ${MAX_FILES} файлов`)
      return
    }
    for (const f of files) {
      if (f.size > MAX_BYTES) {
        toast.error(`«${f.name}» больше 50 МБ`)
        return
      }
      if (!f.type.startsWith('image/') && !f.type.startsWith('video/')) {
        toast.error(`«${f.name}»: только фото или видео`)
        return
      }
    }
    startTransition(async () => {
      // Карточка ещё не сохранена — тихо сохраняем и цепляем файлы к ней.
      const cardId = leadCardId ?? (await ensureCardId?.()) ?? null
      if (!cardId) return
      // Фото сжимаются на клиенте (даунскейл до 2048px + JPEG) — на мобильном
      // интернете загрузка ускоряется в разы. Видео идёт как есть.
      const prepared = await Promise.all(
        files.map((f) =>
          f.type.startsWith('image/') ? compressImageFile(f) : f,
        ),
      )
      const form = new FormData()
      form.set('leadCardId', cardId)
      for (const f of prepared) form.append('files', f)
      // Обычный fetch к API-роуту вместо server action: POST экшена с крупным
      // видео режется прокси-слоями и падает с генерик-ошибкой «An unexpected
      // response was received from the server». Роут отвечает честным JSON.
      try {
        const resp = await fetch('/api/lead-media/upload', {
          method: 'POST',
          body: form,
        })
        let res: {
          ok?: boolean
          message?: string
          attachments?: LeadAttachmentView[]
        } = {}
        try {
          res = (await resp.json()) as typeof res
        } catch {
          /* не-JSON ответ (обрезано прокси) — обработаем ниже по статусу */
        }
        if (resp.ok && res.ok && res.attachments) {
          toast.success(res.message ?? 'Файлы прикреплены.')
          onChanged(res.attachments)
        } else {
          toast.error(
            res.message ??
              (resp.status === 413
                ? 'Файл слишком большой для сервера. Уменьшите видео или загрузите по одному.'
                : 'Ошибка загрузки. Попробуйте ещё раз.'),
          )
        }
      } catch {
        toast.error('Сеть прервала загрузку. Проверьте соединение и попробуйте снова.')
      }
    })
  }

  function remove(att: LeadAttachmentView) {
    startTransition(async () => {
      const res = await deleteLeadAttachmentAction({ attachmentId: att.id })
      if (res.ok && res.attachments) {
        toast.success(res.message)
        onChanged(res.attachments)
        if (viewer?.id === att.id) {
          setViewer(null)
          setConfirmingDelete(false)
        }
      } else {
        toast.error(res.message)
      }
    })
  }

  /** Корзина в сетке: открыть просмотр в режиме подтверждения удаления. */
  function requestDelete(att: LeadAttachmentView) {
    setViewer(att)
    setConfirmingDelete(true)
  }

  function closeViewer() {
    setViewer(null)
    setConfirmingDelete(false)
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold">
          Файлы
          {attachments.length > 0 ? (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {attachments.length}
            </span>
          ) : null}
        </p>
        <div
          className={cn(
            'ml-auto flex items-center gap-1.5',
            readOnly && 'hidden',
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            multiple
            hidden
            onChange={(e) => {
              onFilesPicked(e.target.files)
              e.target.value = ''
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={pending}
            onClick={() => fileInputRef.current?.click()}
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Paperclip className="size-3.5" />
            )}
            Прикрепить
          </Button>
          {conversationId && onBrowseMedia ? (
            <>
              {/* Телеграм-стиль: кнопки открывают навигацию по сообщениям
                  треда (стрелки/Esc), клик по медиа — подтверждение выбора. */}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={pending}
                onClick={() => onBrowseMedia('video_note')}
                title="Найти кружок в диалоге и прикрепить"
              >
                <CircleDot className="size-3.5" />
                Кружок
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={pending}
                onClick={() => onBrowseMedia('photo')}
                title="Найти фото в диалоге и прикрепить"
              >
                <ImageIcon className="size-3.5" />
                Документ
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {attachments.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
          Пока нет файлов. Фото, видео и кружки будут видны менеджеру,
          менеджеру по кадрам и админу.
        </p>
      ) : (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {attachments.map((att) => {
            const canDelete = att.canDelete
            return (
              <li key={att.id} className="group relative">
                <button
                  type="button"
                  className={cn(
                    'block w-full overflow-hidden border border-border bg-muted/40 transition-opacity hover:opacity-90',
                    att.kind === 'video_note'
                      ? 'aspect-square rounded-full'
                      : 'aspect-square rounded-lg',
                  )}
                  onClick={() => setViewer(att)}
                  aria-label={`Открыть ${
                    att.kind === 'photo'
                      ? 'фото'
                      : att.kind === 'video'
                        ? 'видео'
                        : 'кружок'
                  }`}
                >
                  {att.kind === 'photo' ? (
                    // eslint-disable-next-line @next/next/no-img-element -- стриминговый приватный роут
                    <img
                      src={att.url || '/placeholder.svg'}
                      alt={att.fileName ?? 'Фото'}
                      className="size-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="relative flex size-full items-center justify-center">
                      <video
                        src={att.url}
                        muted
                        playsInline
                        preload="metadata"
                        className={cn(
                          'size-full object-cover',
                          att.kind === 'video_note' && 'rounded-full',
                        )}
                      />
                      <span className="absolute inset-0 flex items-center justify-center bg-black/25">
                        <Play className="size-6 fill-white text-white drop-shadow" />
                      </span>
                    </span>
                  )}
                </button>
                {canDelete ? (
                  <button
                    type="button"
                    className="absolute -right-1.5 -top-1.5 z-10 hidden size-6 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm group-hover:flex"
                    onClick={() => requestDelete(att)}
                    disabled={pending}
                    aria-label="Просмотреть и удалить вложение"
                  >
                    <Trash2 className="size-3" />
                  </button>
                ) : null}
                <p className="mt-1 truncate text-[10px] leading-tight text-muted-foreground">
                  {att.authorName ?? '—'}
                  {att.authorRole ? ` · ${ROLE_LABEL[att.authorRole]}` : ''}
                </p>
              </li>
            )
          })}
        </ul>
      )}

      {/* Полноэкранный просмотр. Портал в body обязателен: карточки лида
          анимируются transform-ом, а transform у предка ломает position:fixed
          у потомков — без портала просмотр «съезжал» внутрь панели. */}
      {viewer
        ? createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-200"
          role="dialog"
          aria-modal="true"
          aria-label="Просмотр вложения"
        >
          <button
            type="button"
            className="absolute inset-0"
            aria-label="Закрыть просмотр"
            onClick={closeViewer}
          />
          <div className="relative z-10 flex max-h-full max-w-3xl flex-col items-center animate-in zoom-in-95 fade-in duration-200">
            <Button
              variant="secondary"
              size="icon-sm"
              className="absolute -top-10 right-0"
              onClick={closeViewer}
              aria-label="Закрыть"
            >
              <X className="size-4" />
            </Button>
            {viewer.kind === 'photo' ? (
              // eslint-disable-next-line @next/next/no-img-element -- стриминговый приватный роут
              <img
                src={viewer.url || '/placeholder.svg'}
                alt={viewer.fileName ?? 'Фото'}
                className="max-h-[70dvh] max-w-full rounded-lg object-contain"
              />
            ) : viewer.kind === 'video_note' ? (
              // Кружок — телеграм-стиль плеер: клик = пауза, живой
              // прогресс-обод и оставшееся время внутри кружка.
              <VideoNotePlayer src={viewer.url} size={320} autoPlay />
            ) : (
              <video
                src={viewer.url}
                controls
                autoPlay
                playsInline
                className="max-h-[70dvh] max-w-full rounded-lg object-contain"
              />
            )}
            <p className="mt-2 text-center text-xs text-white/80">
              {viewer.authorName ?? '—'}
              {viewer.authorRole ? ` · ${ROLE_LABEL[viewer.authorRole]}` : ''}
              {' · '}
              {formatDateTime(viewer.createdAt)}
            </p>
            {confirmingDelete && viewer.canDelete ? (
              // Панель «просмотрите и подтвердите»: удаление только после
              // повторного клика — случайно снести кружок больше нельзя.
              <div className="mt-3 flex items-center gap-2 rounded-xl bg-black/60 px-3 py-2 backdrop-blur-sm">
                <p className="text-xs text-white/90">Удалить это вложение?</p>
                <Button
                  variant="destructive"
                  size="sm"
                  className="gap-1.5"
                  disabled={pending}
                  onClick={() => remove(viewer)}
                >
                  {pending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                  Удалить
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pending}
                  onClick={() => setConfirmingDelete(false)}
                >
                  Оставить
                </Button>
              </div>
            ) : viewer.canDelete ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-3 gap-1.5 text-white/70 hover:bg-white/10 hover:text-white"
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash2 className="size-3.5" />
                Удалить
              </Button>
            ) : null}
          </div>
        </div>,
            document.body,
          )
        : null}
    </div>
  )
}


