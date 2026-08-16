import { cn } from '@/lib/utils'

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('skeleton-shimmer rounded-md bg-muted', className)}
      {...props}
    />
  )
}

export { Skeleton }
