'use client'

/**
 * Общие примитивы вкладок редактора виджета: тип пропсов, обёртка поля формы
 * и мелкие хелперы, используемые несколькими вкладками.
 */

import { Label } from '@/components/ui/label'
import type { LivechatWidgetConfig } from '@/lib/widget-config'

export type TabProps = {
  config: LivechatWidgetConfig
  patch: (updater: (draft: LivechatWidgetConfig) => void) => void
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export const HEX_RE = /^#[0-9a-fA-F]{6}$/

/**
 * Load an image file, center-crop it to a square, downscale to `size` px, and
 * return a compact JPEG data URL. Keeps stored avatars tiny and self-contained.
 */
export function downscaleImage(file: File, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('no canvas context'))
        return
      }
      const side = Math.min(img.width, img.height)
      const sx = (img.width - side) / 2
      const sy = (img.height - side) / 2
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image load failed'))
    }
    img.src = url
  })
}

export function timeValue(h: number, m: number): string {
  const hh = String(h).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  return `${hh}:${mm}`
}

export function parseTime(v: string): { h: number; m: number } {
  const [h, m] = v.split(':').map((x) => Number.parseInt(x, 10))
  return {
    h: Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 0,
    m: Number.isFinite(m) ? Math.min(59, Math.max(0, m)) : 0,
  }
}
