import type {
  AppRuntime,
  AppStatus,
  DeploymentStatus,
  ServerStatus,
} from '@/lib/types'

/* Shared label/color maps for the App Hosting ("Серверы") UI. Kept in one place
   so server cards, app cards and detail views stay visually consistent. */

export const SERVER_STATUS_LABEL: Record<ServerStatus, string> = {
  online: 'В сети',
  offline: 'Не в сети',
  unknown: 'Не проверен',
}

export const SERVER_STATUS_DOT: Record<ServerStatus, string> = {
  online: 'bg-success',
  offline: 'bg-destructive',
  unknown: 'bg-muted-foreground',
}

export const APP_STATUS_LABEL: Record<AppStatus, string> = {
  stopped: 'Остановлено',
  building: 'Сборка',
  running: 'Работает',
  error: 'Ошибка',
}

export const APP_STATUS_DOT: Record<AppStatus, string> = {
  stopped: 'bg-muted-foreground',
  building: 'bg-warning',
  running: 'bg-success',
  error: 'bg-destructive',
}

export const RUNTIME_LABEL: Record<AppRuntime, string> = {
  node: 'Node.js',
  docker: 'Docker',
  static: 'Статика',
  php: 'PHP',
}

export const DEPLOYMENT_STATUS_LABEL: Record<DeploymentStatus, string> = {
  queued: 'В очереди',
  cloning: 'Клонирование',
  building: 'Сборка',
  running: 'Запуск',
  success: 'Успешно',
  failed: 'Ошибка',
}

export const DEPLOYMENT_STATUS_DOT: Record<DeploymentStatus, string> = {
  queued: 'bg-muted-foreground',
  cloning: 'bg-warning',
  building: 'bg-warning',
  running: 'bg-warning',
  success: 'bg-success',
  failed: 'bg-destructive',
}

/** True while a deployment is still in flight (used to keep the log stream open). */
export function isDeploymentActive(status: DeploymentStatus): boolean {
  return status !== 'success' && status !== 'failed'
}

/** Format a metric percentage (0–100) or a dash when unknown. */
export function fmtPct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v)}%`
}

/** Tailwind color for a usage bar by threshold (green/amber/red). */
export function usageColor(v: number | null): string {
  if (v === null) return 'bg-muted-foreground'
  if (v >= 90) return 'bg-destructive'
  if (v >= 70) return 'bg-warning'
  return 'bg-success'
}
