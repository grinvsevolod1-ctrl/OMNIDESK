import { APP_TIME_ZONE } from '@/lib/time'

/** Единый формат даты-времени для всех блоков карточки лида. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  })
}
