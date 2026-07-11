import type { ComponentType } from 'react'
import { MessageCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChannelType } from '@/lib/types'

/**
 * Shared brand icons for every messenger channel plus Yandex Telemost.
 *
 * All marks are authored from the official logos and normalised to a single
 * visual system: each renders full-bleed inside a square viewBox so that at a
 * given `size-*` they share the same optical scale and alignment. Colours are
 * baked into the artwork (these are logos, not themable glyphs), so callers
 * only control the box size via `className`. Gradient ids are stable and the
 * gradient definitions are identical across instances, so repeated ids on one
 * page resolve harmlessly to the first (identical) definition.
 */

export type BrandIconProps = { className?: string }
export type BrandIconComponent = ComponentType<BrandIconProps>

const BASE = 'size-5 shrink-0'

export function TelegramIcon({ className }: BrandIconProps) {
  return (
    <svg
      viewBox="0 0 240.1 240.1"
      className={cn(BASE, className)}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id="omni-tg-grad"
          x1="120.05"
          y1="0"
          x2="120.05"
          y2="238.39"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#2AABEE" />
          <stop offset="1" stopColor="#229ED9" />
        </linearGradient>
      </defs>
      <circle cx="120.1" cy="120.1" r="120.1" fill="url(#omni-tg-grad)" />
      <path
        fill="#FFFFFF"
        d="M54.3,118.8c35-15.2,58.3-25.3,70-30.2c33.3-13.9,40.3-16.3,44.8-16.4c1,0,3.2,0.2,4.7,1.4c1.2,1,1.5,2.3,1.7,3.3s0.4,3.1,0.2,4.7c-1.8,19-9.6,65.1-13.6,86.3c-1.7,9-5,12-8.2,12.3c-7,0.6-12.3-4.6-19-9c-10.6-6.9-16.5-11.2-26.8-18c-11.9-7.8-4.2-12.1,2.6-19.1c1.8-1.8,32.5-29.8,33.1-32.3c0.1-0.3,0.1-1.5-0.6-2.1c-0.7-0.6-1.7-0.4-2.5-0.2c-1.1,0.2-17.9,11.4-50.6,33.5c-4.8,3.3-9.1,4.9-13,4.8c-4.3-0.1-12.5-2.4-18.7-4.4c-7.5-2.4-13.5-3.7-13-7.9C45.7,123.3,48.7,121.1,54.3,118.8z"
      />
    </svg>
  )
}

export function WhatsappIcon({ className }: BrandIconProps) {
  return (
    <svg
      viewBox="2 2 28 28"
      className={cn(BASE, className)}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id="omni-wa-grad"
          x1="26.5"
          y1="7"
          x2="4"
          y2="28"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#5BD066" />
          <stop offset="1" stopColor="#27B43E" />
        </linearGradient>
      </defs>
      <path
        d="M28 16C28 22.6274 22.6274 28 16 28C13.4722 28 11.1269 27.2184 9.19266 25.8837L5.09091 26.9091L6.16576 22.8784C4.80092 20.9307 4 18.5589 4 16C4 9.37258 9.37258 4 16 4C22.6274 4 28 9.37258 28 16Z"
        fill="url(#omni-wa-grad)"
      />
      <path
        fill="#FFFFFF"
        d="M12.5 9.49989C12.1672 8.83131 11.6565 8.8905 11.1407 8.8905C10.2188 8.8905 8.78125 9.99478 8.78125 12.05C8.78125 13.7343 9.52345 15.578 12.0244 18.3361C14.438 20.9979 17.6094 22.3748 20.2422 22.3279C22.875 22.2811 23.4167 20.0154 23.4167 19.2503C23.4167 18.9112 23.2062 18.742 23.0613 18.696C22.1641 18.2654 20.5093 17.4631 20.1328 17.3124C19.7563 17.1617 19.5597 17.3656 19.4375 17.4765C19.0961 17.8018 18.4193 18.7608 18.1875 18.9765C17.9558 19.1922 17.6103 19.083 17.4665 19.0015C16.9374 18.7892 15.5029 18.1511 14.3595 17.0426C12.9453 15.6718 12.8623 15.2001 12.5959 14.7803C12.3828 14.4444 12.5392 14.2384 12.6172 14.1483C12.9219 13.7968 13.3426 13.254 13.5313 12.9843C13.7199 12.7145 13.5702 12.305 13.4803 12.05C13.0938 10.953 12.7663 10.0347 12.5 9.49989Z"
      />
    </svg>
  )
}

export function VkIcon({ className }: BrandIconProps) {
  return (
    <svg
      viewBox="0 0 101 100"
      className={cn(BASE, className)}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fill="#0077FF"
        d="M0.5 48C0.5 25.3726 0.5 14.0589 7.52944 7.02944C14.5589 0 25.8726 0 48.5 0H52.5C75.1274 0 86.4411 0 93.4706 7.02944C100.5 14.0589 100.5 25.3726 100.5 48V52C100.5 74.6274 100.5 85.9411 93.4706 92.9706C86.4411 100 75.1274 100 52.5 100H48.5C25.8726 100 14.5589 100 7.52944 92.9706C0.5 85.9411 0.5 74.6274 0.5 52V48Z"
      />
      <path
        fill="#FFFFFF"
        d="M53.7085 72.042C30.9168 72.042 17.9169 56.417 17.3752 30.417H28.7919C29.1669 49.5003 37.5834 57.5836 44.25 59.2503V30.417H55.0004V46.8752C61.5837 46.1669 68.4995 38.667 70.8329 30.417H81.5832C79.7915 40.5837 72.2915 48.0836 66.9582 51.1669C72.2915 53.6669 80.8336 60.2086 84.0836 72.042H72.2499C69.7082 64.1253 63.3754 58.0003 55.0004 57.1669V72.042H53.7085Z"
      />
    </svg>
  )
}

export function MaxIcon({ className }: BrandIconProps) {
  return (
    <svg
      viewBox="0 0 1000 1000"
      className={cn(BASE, className)}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id="omni-max-grad"
          x1="117.847"
          x2="1000"
          y1="760.536"
          y2="500"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#4cf" />
          <stop offset=".662" stopColor="#53e" />
          <stop offset="1" stopColor="#93d" />
        </linearGradient>
        <radialGradient
          id="omni-max-overlay"
          cx="-87.392"
          cy="1166.116"
          r="500"
          fx="-87.392"
          fy="1166.116"
          gradientTransform="rotate(51.356 1551.478 559.3) scale(2.42703433 1)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#00f" />
          <stop offset="1" stopColor="#00f" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="1000" height="1000" fill="url(#omni-max-grad)" ry="249.681" />
      <rect
        width="1000"
        height="1000"
        fill="url(#omni-max-overlay)"
        ry="249.681"
      />
      <path
        fill="#FFFFFF"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M508.211 878.328c-75.007 0-109.864-10.95-170.453-54.75-38.325 49.275-159.686 87.783-164.979 21.9 0-49.456-10.95-91.248-23.36-136.873-14.782-56.21-31.572-118.807-31.572-209.508 0-216.626 177.754-379.597 388.357-379.597 210.785 0 375.947 171.001 375.947 381.604.707 207.346-166.595 376.118-373.94 377.224m3.103-571.585c-102.564-5.292-182.499 65.7-200.201 177.024-14.6 92.162 11.315 204.398 33.397 210.238 10.585 2.555 37.23-18.98 53.837-35.587a189.8 189.8 0 0 0 92.71 33.032c106.273 5.112 197.08-75.794 204.215-181.95 4.154-106.382-77.67-196.486-183.958-202.574Z"
      />
    </svg>
  )
}

export function TelemostIcon({ className }: BrandIconProps) {
  return (
    <svg
      viewBox="0 0 1000 1000"
      className={cn(BASE, className)}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <radialGradient
          id="omni-tm-grad"
          cx="390.3504333"
          cy="687.5618896"
          r="10"
          gradientTransform="matrix(4.000000e-15 64 83.0970001 -5.000000e-15 -56634.3320312 -24622.4277344)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#F69572" />
          <stop offset="0.5" stopColor="#F16531" />
          <stop offset="1" stopColor="#F05A22" />
        </radialGradient>
      </defs>
      <path
        fill="url(#omni-tm-grad)"
        d="M500,1000c276.1419678,0,500-223.8580322,500-500S776.1419678,0,500,0S0,223.8580017,0,500S223.8580017,1000,500,1000z"
      />
      <ellipse fill="#FFFFFF" cx="500" cy="500" rx="170" ry="290" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill="#FFFFFF"
        d="M181.2556763,270.0079346C130.8000946,267.4084473,70,372.9868774,70,499.9608765s60.8000946,232.5524292,111.2556763,229.9529419c50.0333405-2.5994873,78.7443542-102.9789429,78.7443542-229.9529419S231.2890167,272.6074219,181.2556763,270.0079346z"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill="#FFFFFF"
        d="M818.7443237,729.9138184C869.1999512,732.5133057,930,626.9348755,930,499.9608765s-60.8000488-232.5524292-111.2556763-229.9529419C768.7109985,272.6074219,740,372.9868774,740,499.9608765S768.7109985,727.3143311,818.7443237,729.9138184z"
      />
    </svg>
  )
}

/**
 * Live-chat is our own widget rather than a third-party brand, so it stays a
 * monochrome glyph that inherits `currentColor` — but drawn full-bleed at the
 * same scale as the brand marks so the set stays visually consistent.
 */
export function LivechatIcon({ className }: BrandIconProps) {
  return <MessageCircle className={cn(BASE, className)} aria-hidden="true" />
}

const CHANNEL_ICONS: Record<ChannelType, BrandIconComponent> = {
  telegram: TelegramIcon,
  whatsapp: WhatsappIcon,
  vk: VkIcon,
  max: MaxIcon,
  livechat: LivechatIcon,
}

/** Resolve the brand icon component for a channel type. */
export function channelIcon(type: ChannelType): BrandIconComponent {
  return CHANNEL_ICONS[type] ?? LivechatIcon
}

/**
 * Render the brand icon for a channel type directly. Uses a switch (rather than
 * a lookup assigned to a capitalised variable) so it never trips the
 * "component created during render" lint rule.
 */
export function ChannelIcon({
  type,
  className,
}: {
  type: ChannelType
  className?: string
}) {
  switch (type) {
    case 'telegram':
      return <TelegramIcon className={className} />
    case 'whatsapp':
      return <WhatsappIcon className={className} />
    case 'vk':
      return <VkIcon className={className} />
    case 'max':
      return <MaxIcon className={className} />
    case 'livechat':
    default:
      return <LivechatIcon className={className} />
  }
}
