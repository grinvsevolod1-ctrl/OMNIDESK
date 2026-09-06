import { Skeleton } from '@/components/ui/skeleton'

// Suspense fallback for the head-of-group workspace (lead lists / team).
export default function HeadLoading() {
  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Загрузка…</span>
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-28 rounded-xl" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-9 w-40 rounded-xl" />
        <Skeleton className="h-9 w-32 rounded-xl" />
      </div>
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    </div>
  )
}
