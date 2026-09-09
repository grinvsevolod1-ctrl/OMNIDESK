'use client'

/**
 * Логотип рекламной площадки: брендовый SVG из theSVG (через <img>) с
 * автоматическим фолбэком на монограмму (буквы на фоне бренд-цвета), если у
 * платформы нет slug или картинка не загрузилась. Единая точка отображения
 * логотипа для модалки каталога, карточек источников и детальной страницы.
 */

import { useState } from 'react'
import {
  platformLogoUrl,
  platformMonogram,
  type CatalogPlatform,
} from '@/lib/traffic-source-catalog'
import { cn } from '@/lib/utils'

/** Достаточный контраст текста монограммы на бренд-цвете (яркость по WCAG-ish). */
function readableText(hex: string): string {
  const h = hex.replace('#', '')
  if (h.length !== 6) return '#fff'
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.6 ? '#111' : '#fff'
}

export function PlatformLogo({
  platform,
  size = 40,
  className,
  rounded = 'rounded-xl',
}: {
  platform: CatalogPlatform
  size?: number
  className?: string
  rounded?: string
}) {
  const [failed, setFailed] = useState(false)
  const isCustom = Boolean(platform.logoUrl)
  const url = platform.logoUrl ?? platformLogoUrl(platform.logoSlug)
  const showMonogram = !url || failed

  if (showMonogram) {
    return (
      <span
        className={cn(
          'flex shrink-0 items-center justify-center font-semibold',
          rounded,
          className,
        )}
        style={{
          width: size,
          height: size,
          backgroundColor: `#${platform.hex}`,
          color: readableText(platform.hex),
          fontSize: size * 0.36,
        }}
        aria-hidden
      >
        {platformMonogram(platform)}
      </span>
    )
  }

  // Локальный логотип уже содержит собственный фон (напр. Яндекс Директ —
  // чёрная плитка с белой стрелкой) — рисуем во всю плитку без белой подложки.
  if (isCustom) {
    return (
      <span
        className={cn('flex shrink-0 overflow-hidden', rounded, className)}
        style={{ width: size, height: size }}
      >
        {/* Intentional <img>: logos come from arbitrary external CDNs (theSVG /
            jsDelivr) and per-source custom URLs whose domains can't be
            whitelisted in next/image remotePatterns, and we rely on the native
            onError → monogram fallback. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url || '/placeholder.svg'}
          alt=""
          width={size}
          height={size}
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </span>
    )
  }

  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center bg-white/90 p-1.5',
        rounded,
        className,
      )}
      style={{ width: size, height: size }}
    >
      {/* Логотип бренда из theSVG.org (jsDelivr CDN). Intentional <img>: external
          CDN domain isn't whitelistable in next/image and we rely on the native
          onError → monogram fallback. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url || '/placeholder.svg'}
        alt=""
        width={size * 0.7}
        height={size * 0.7}
        className="h-full w-full object-contain"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </span>
  )
}
