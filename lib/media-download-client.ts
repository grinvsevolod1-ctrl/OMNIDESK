/**
 * Browser-only bulk download machinery: fetch the selected media as blobs (with
 * bounded concurrency + progress), then hand them over as individual files —
 * Web Share on phones (lands in the photo gallery via "Save N images"), anchor
 * downloads on desktop — or pack them into one ZIP with fflate.
 */

import { zipSync, type Zippable } from 'fflate'
import type { Message } from '@/lib/types'
import { bulkFilenames } from '@/lib/media-download'

export interface PreparedFile {
  message: Message
  file: File
}

export interface PrepareOutcome {
  files: PreparedFile[]
  /** Messages whose bytes could not be fetched (media gone / server error). */
  failed: Message[]
}

/** Parallel fetches: enough to hide latency, few enough to spare a phone. */
const FETCH_CONCURRENCY = 4

/**
 * Fetch every selected item as a File (named in thread order). Failures are
 * collected, not thrown, so one dead photo never aborts a 100-photo export.
 */
export async function prepareFiles(
  messages: Message[],
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<PrepareOutcome> {
  const names = bulkFilenames(messages)
  const files: (PreparedFile | null)[] = messages.map(() => null)
  const failed: Message[] = []
  let done = 0
  let next = 0
  onProgress(0, messages.length)

  const worker = async () => {
    while (next < messages.length) {
      if (signal?.aborted) return
      const i = next++
      const m = messages[i]
      try {
        const res = await fetch(m.mediaUrl!, { signal })
        if (!res.ok) throw new Error(`status ${res.status}`)
        const blob = await res.blob()
        const type = blob.type || m.mediaMime || 'application/octet-stream'
        files[i] = {
          message: m,
          file: new File([blob], names[i], {
            type,
            lastModified: new Date(m.createdAt).getTime(),
          }),
        }
      } catch (err) {
        if (signal?.aborted) return
        console.error('[v0] bulk media fetch failed:', m.id, err)
        failed.push(m)
      } finally {
        done++
        onProgress(done, messages.length)
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, messages.length) }, worker),
  )
  return {
    files: files.filter((f): f is PreparedFile => f !== null),
    failed,
  }
}

/**
 * Can this browser hand a set of image/video files to the OS share sheet? That
 * is the path that saves straight into the photo gallery on iOS/Android.
 */
export function canShareFiles(files: File[]): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean
  }
  if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function') {
    return false
  }
  if (files.length === 0) return false
  try {
    return nav.canShare({ files })
  } catch {
    return false
  }
}

/** Heuristic for "prefer the share sheet": touch-first device with Web Share. */
export function isMobileLike(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false
  const coarse =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  return coarse && typeof navigator.share === 'function'
}

/**
 * Open the OS share sheet with the files. MUST be called synchronously inside a
 * user gesture (Safari drops the transient activation across awaits), which is
 * why the UI prepares first and shares on a SECOND tap. Returns false when the
 * user dismissed the sheet or the browser refused.
 */
export async function shareFiles(files: File[], title: string): Promise<boolean> {
  try {
    await navigator.share({ files, title })
    return true
  } catch (err) {
    // AbortError = user closed the sheet; not an error worth surfacing.
    if (err instanceof DOMException && err.name === 'AbortError') return false
    console.error('[v0] share failed:', err)
    return false
  }
}

/** Trigger a classic browser download of one blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke a tick later so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

/**
 * Save each file separately via anchor clicks. Desktop browsers ask once for
 * "download multiple files" and then let the whole loop through; a short gap
 * between clicks keeps Chrome from coalescing/dropping them.
 */
export async function downloadEach(files: File[]): Promise<void> {
  for (let i = 0; i < files.length; i++) {
    downloadBlob(files[i], files[i].name)
    if (i < files.length - 1) await new Promise((r) => setTimeout(r, 180))
  }
}

/**
 * Pack the files into ONE zip. Photos/videos are already compressed, so the
 * entries are STORED (level 0): instant even for 100 files, and the archive
 * is not measurably bigger than deflating would make it.
 */
export async function packZip(files: File[]): Promise<Blob> {
  const entries: Zippable = {}
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer())
    entries[f.name] = [
      bytes,
      { level: 0, mtime: new Date(f.lastModified) },
    ]
  }
  const zipped = zipSync(entries)
  return new Blob([zipped as unknown as BlobPart], { type: 'application/zip' })
}
