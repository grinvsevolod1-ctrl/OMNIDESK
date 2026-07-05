import { cn } from '@/lib/utils'

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn('size-6', className)}
    >
      <path d="M12 2L22 20H2L12 2Z" fill="currentColor" />
    </svg>
  )
}

export function BrandWordmark({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <BrandMark className="size-5 text-foreground" />
      <span className="text-sm font-semibold tracking-tight">Omnidesk</span>
    </div>
  )
}
