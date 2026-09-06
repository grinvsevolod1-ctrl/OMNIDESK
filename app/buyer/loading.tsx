import { Skeleton } from '@/components/ui/skeleton'

// Suspense fallback for the media-buyer workspace (source cards + leads).
export default function BuyerLoading() {
  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Загрузка…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-36 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-9 w-56 rounded-xl" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
    </div>
  )
}
