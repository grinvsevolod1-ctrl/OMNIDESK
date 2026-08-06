import { Skeleton } from '@/components/ui/skeleton'

// Suspense fallback for the curator workspace while lead cards load.
export default function CuratorLoading() {
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Загрузка…</span>
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-9 w-24 rounded-xl" />
      </div>
      <Skeleton className="h-10 w-48 rounded-xl" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full rounded-xl" />
        ))}
      </div>
    </div>
  )
}
