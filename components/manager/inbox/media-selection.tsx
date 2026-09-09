'use client'

/**
 * Bulk photo selection for the thread — shared by the manager and curator
 * inboxes because both render the same MessageList.
 *
 * Flow: a small "Выбрать фото" chip in the feed enters selection mode; every
 * photo/video tile then toggles a checkmark instead of opening the viewer; a
 * sticky bar at the bottom of the feed offers Download / ZIP. Download prepares
 * the files first (fetch with progress) and then either hands them to the OS
 * share sheet on phones (→ "Save N images" into the gallery) or triggers
 * per-file browser downloads on desktop. ZIP packs the same files client-side.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Archive,
  Check,
  CheckSquare,
  Download,
  ImageDown,
  Loader2,
  Share2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Message } from '@/lib/types'
import { isSelectableMedia } from '@/lib/media-albums'
import { zipFilename } from '@/lib/media-download'
import {
  canShareFiles,
  downloadBlob,
  downloadEach,
  isMobileLike,
  packZip,
  prepareFiles,
  shareFiles,
  type PreparedFile,
} from '@/lib/media-download-client'

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

export interface MediaSelection {
  /** Selection mode is on: tiles toggle instead of opening. */
  active: boolean
  /** Every selectable photo/video currently loaded in the thread. */
  selectable: Message[]
  /** Selected items in thread order. */
  selected: Message[]
  isSelected: (id: string) => boolean
  toggle: (id: string) => void
  selectAll: () => void
  clear: () => void
  enter: () => void
  exit: () => void
}

/**
 * Owns the selected-id set for the open thread. Resets whenever the dialog
 * changes and prunes ids that scrolled out of the loaded thread (deleted or
 * replaced by a refresh) so the bar never counts phantom items.
 */
export function useMediaSelection(
  thread: Message[],
  conversationId: string | null,
): MediaSelection {
  // State is keyed by the conversation it belongs to: switching dialogs makes
  // the stored key stale, and stale state reads as "mode off, nothing selected"
  // — a reset without an effect and without a render of leaked selection.
  const [state, setState] = useState<{
    key: string | null
    active: boolean
    ids: Set<string>
  }>({ key: conversationId, active: false, ids: new Set() })
  const current =
    state.key === conversationId
      ? state
      : { key: conversationId, active: false, ids: new Set<string>() }

  const selectable = useMemo(() => thread.filter(isSelectableMedia), [thread])
  const selectableIds = useMemo(
    () => new Set(selectable.map((m) => m.id)),
    [selectable],
  )
  // Ids that left the loaded thread (deleted / replaced by a refresh) are
  // ignored at read time instead of pruned in an effect.
  const ids = useMemo(() => {
    const next = new Set<string>()
    current.ids.forEach((id) => {
      if (selectableIds.has(id)) next.add(id)
    })
    return next
  }, [current.ids, selectableIds])
  const active = current.active

  const update = useCallback(
    (patch: (prev: { active: boolean; ids: Set<string> }) => {
      active: boolean
      ids: Set<string>
    }) =>
      setState((prev) => {
        const base =
          prev.key === conversationId
            ? prev
            : { key: conversationId, active: false, ids: new Set<string>() }
        return { key: conversationId, ...patch(base) }
      }),
    [conversationId],
  )

  const toggle = useCallback(
    (id: string) =>
      update((prev) => {
        const next = new Set(prev.ids)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return { active: prev.active, ids: next }
      }),
    [update],
  )
  const selectAll = useCallback(
    () =>
      update((prev) => ({
        active: prev.active,
        ids: new Set(selectable.map((m) => m.id)),
      })),
    [update, selectable],
  )
  const clear = useCallback(
    () => update((prev) => ({ active: prev.active, ids: new Set() })),
    [update],
  )
  const enter = useCallback(
    () => update((prev) => ({ active: true, ids: prev.ids })),
    [update],
  )
  const exit = useCallback(
    () => update(() => ({ active: false, ids: new Set() })),
    [update],
  )

  const selected = useMemo(
    () => selectable.filter((m) => ids.has(m.id)),
    [selectable, ids],
  )
  const isSelected = useCallback((id: string) => ids.has(id), [ids])

  return {
    active,
    selectable,
    selected,
    isSelected,
    toggle,
    selectAll,
    clear,
    enter,
    exit,
  }
}

/* ------------------------------------------------------------------ */
/* Context consumed by the tiles                                        */
/* ------------------------------------------------------------------ */

type TileSelectionValue = {
  active: boolean
  isSelected: (id: string) => boolean
  toggle: (id: string) => void
}
const TileSelectionContext = createContext<TileSelectionValue | null>(null)

export function MediaSelectionProvider({
  selection,
  children,
}: {
  selection: MediaSelection
  children: ReactNode
}) {
  const value = useMemo<TileSelectionValue>(
    () => ({
      active: selection.active,
      isSelected: selection.isSelected,
      toggle: selection.toggle,
    }),
    [selection.active, selection.isSelected, selection.toggle],
  )
  return (
    <TileSelectionContext.Provider value={value}>
      {children}
    </TileSelectionContext.Provider>
  )
}

/**
 * For a media tile: whether selection mode is on, whether THIS message is
 * selected, and a click handler that toggles it. Returns `null` when the tile
 * should behave normally (no provider, mode off, or not a photo/video).
 */
export function useTileSelection(message: Message): {
  selected: boolean
  onSelect: () => void
} | null {
  const ctx = useContext(TileSelectionContext)
  if (!ctx || !ctx.active || !isSelectableMedia(message)) return null
  return {
    selected: ctx.isSelected(message.id),
    onSelect: () => ctx.toggle(message.id),
  }
}

/** Checkmark badge overlaid on a selectable tile while selection mode is on. */
export function SelectionBadge({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full border-2 shadow-sm transition-colors',
        selected
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-background/90 bg-background/40 text-transparent backdrop-blur-sm',
      )}
    >
      <Check className="size-3.5" strokeWidth={3} />
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Entry chip                                                           */
/* ------------------------------------------------------------------ */

/** Floating chip that turns selection mode on; hidden once it is on. */
export function MediaSelectionChip({
  selection,
}: {
  selection: MediaSelection
}) {
  // Nothing to bulk-select with a single photo — the lightbox already saves it.
  if (selection.active || selection.selectable.length < 2) return null
  return (
    <div className="sticky top-0 z-10 flex justify-end">
      <button
        type="button"
        onClick={selection.enter}
        className="flex items-center gap-1.5 rounded-full border border-border/70 bg-card/90 px-2.5 py-1 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-card hover:text-foreground"
        title="Выбрать несколько фото для скачивания"
      >
        <CheckSquare className="size-3.5" />
        Выбрать фото
        <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums">
          {selection.selectable.length}
        </span>
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Action bar                                                           */
/* ------------------------------------------------------------------ */

type Phase =
  | { kind: 'idle' }
  | { kind: 'preparing'; done: number; total: number; intent: 'files' | 'zip' }
  | { kind: 'zipping' }
  /** Files fetched; waiting for the SECOND tap that opens the share sheet. */
  | { kind: 'ready'; files: PreparedFile[] }

/**
 * Sticky bar at the bottom of the feed while selection mode is on: count,
 * select-all, Download, ZIP, close. Download/ZIP are two-stage (prepare → act)
 * because Web Share must run synchronously inside a tap.
 */
export function MediaSelectionBar({
  selection,
  contactName,
}: {
  selection: MediaSelection
  contactName?: string
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const abortRef = useRef<AbortController | null>(null)

  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    [],
  )

  const count = selection.selected.length
  const allSelected =
    count > 0 && count === selection.selectable.length

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setPhase({ kind: 'idle' })
  }, [])

  const close = useCallback(() => {
    reset()
    selection.exit()
  }, [reset, selection])

  // Stage 1 for both actions: fetch the bytes. Returns null when cancelled or
  // nothing could be fetched.
  const prepare = useCallback(
    async (intent: 'files' | 'zip'): Promise<PreparedFile[] | null> => {
      const items = selection.selected
      if (items.length === 0) return null
      const controller = new AbortController()
      abortRef.current = controller
      setPhase({ kind: 'preparing', done: 0, total: items.length, intent })
      const { files, failed } = await prepareFiles(
        items,
        (done, total) =>
          setPhase((p) =>
            p.kind === 'preparing' ? { ...p, done, total } : p,
          ),
        controller.signal,
      )
      if (controller.signal.aborted) return null
      if (failed.length) {
        toast.error(
          failed.length === items.length
            ? 'Не удалось загрузить выбранные файлы.'
            : `${failed.length} из ${items.length} файлов не удалось загрузить — они пропущены.`,
        )
      }
      if (files.length === 0) {
        setPhase({ kind: 'idle' })
        return null
      }
      return files.map((f) => f)
    },
    [selection.selected],
  )

  const onDownload = useCallback(async () => {
    const files = await prepare('files')
    if (!files) return
    const raw = files.map((f) => f.file)
    // Phones: hand off to the share sheet on the NEXT tap (gallery save).
    if (isMobileLike() && canShareFiles(raw)) {
      setPhase({ kind: 'ready', files })
      return
    }
    await downloadEach(raw)
    toast.success(
      raw.length === 1 ? 'Файл скачан.' : `Скачано файлов: ${raw.length}.`,
    )
    close()
  }, [prepare, close])

  const onShare = useCallback(async () => {
    if (phase.kind !== 'ready') return
    const raw = phase.files.map((f) => f.file)
    const ok = await shareFiles(
      raw,
      raw.length === 1 ? 'Фото из диалога' : `${raw.length} фото из диалога`,
    )
    if (ok) {
      toast.success('Передано в галерею.')
      close()
    }
    // Dismissed: stay in 'ready' so a second attempt needs no re-download.
  }, [phase, close])

  const onZip = useCallback(async () => {
    const files =
      phase.kind === 'ready' ? phase.files : await prepare('zip')
    if (!files) return
    setPhase({ kind: 'zipping' })
    try {
      const blob = await packZip(files.map((f) => f.file))
      downloadBlob(blob, zipFilename(contactName))
      toast.success(`ZIP с ${files.length} файлами готов.`)
      close()
    } catch (err) {
      console.error('[media] zip failed:', err)
      toast.error('Не удалось собрать ZIP. Попробуйте скачать по отдельности.')
      setPhase({ kind: 'idle' })
    }
  }, [phase, prepare, contactName, close])

  if (!selection.active) return null

  const busy = phase.kind === 'preparing' || phase.kind === 'zipping'

  return (
    <div className="sticky bottom-0 z-10 mt-2 flex justify-center pb-1">
      <div
        role="toolbar"
        aria-label="Выбранные фото"
        className="flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-2xl border border-border bg-card/95 px-3 py-2 shadow-lg backdrop-blur"
      >
        <span className="text-sm font-medium tabular-nums">
          {count === 0
            ? 'Отметьте фото'
            : `Выбрано ${count}`}
        </span>

        {phase.kind === 'preparing' ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            <span className="shrink-0 tabular-nums">
              Загрузка {phase.done} из {phase.total}
            </span>
            <div
              className="h-1 min-w-12 flex-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={phase.total}
              aria-valuenow={phase.done}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200"
                style={{
                  width: `${phase.total ? Math.round((phase.done / phase.total) * 100) : 0}%`,
                }}
              />
            </div>
            <Button variant="ghost" size="sm" onClick={reset}>
              Отмена
            </Button>
          </div>
        ) : phase.kind === 'zipping' ? (
          <div className="flex flex-1 items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Собираю ZIP…
          </div>
        ) : phase.kind === 'ready' ? (
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" onClick={onShare} className="gap-1.5">
              <Share2 className="size-4" />
              Сохранить {phase.files.length} в галерею
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onZip}
              className="gap-1.5"
              title="Скачать одним ZIP-архивом"
            >
              <Archive className="size-4" />
              ZIP
            </Button>
          </div>
        ) : (
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={allSelected ? selection.clear : selection.selectAll}
              disabled={busy || selection.selectable.length === 0}
              className="text-xs"
            >
              {allSelected ? 'Снять все' : `Выбрать все (${selection.selectable.length})`}
            </Button>
            <Button
              size="sm"
              onClick={onDownload}
              disabled={busy || count === 0}
              className="gap-1.5"
              title="Скачать выбранные фото файлами"
            >
              {isMobileLike() ? (
                <ImageDown className="size-4" />
              ) : (
                <Download className="size-4" />
              )}
              Скачать
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onZip}
              disabled={busy || count === 0}
              className="gap-1.5"
              title="Скачать одним ZIP-архивом"
            >
              <Archive className="size-4" />
              ZIP
            </Button>
          </div>
        )}

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={close}
          aria-label="Выйти из режима выбора"
          className="shrink-0"
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  )
}
