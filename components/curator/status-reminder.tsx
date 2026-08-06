'use client'

import { useEffect, useRef } from 'react'
import { leadNeedsDailyStatus } from '@/lib/lead-status'
import type { LeadCard } from '@/lib/data/lead-cards'

const INTERVAL_MS = 20 * 60 * 1000 // 20 minutes

/**
 * While the curator has pending daily status updates, fire a browser
 * Notification every 20 minutes (and once on mount if permission is granted).
 */
export function StatusReminder({ leads }: { leads: LeadCard[] }) {
  const pendingCount = leads.filter((l) =>
    leadNeedsDailyStatus(l),
  ).length
  const hasPending = pendingCount > 0
  const countRef = useRef(pendingCount)

  useEffect(() => {
    countRef.current = pendingCount
  }, [pendingCount])

  useEffect(() => {
    if (!hasPending) return
    if (typeof window === 'undefined' || !('Notification' in window)) return

    function notify() {
      const n = countRef.current
      if (n <= 0) return
      if (Notification.permission !== 'granted') return
      try {
        const body =
          n === 1
            ? '1 лид ждёт обновления статуса'
            : `${n} лидов ждут обновления статуса`
        const opts: NotificationOptions & { renotify?: boolean } = {
          body: `${body}. Пока статусы не подтверждены, рабочее место ограничено.`,
          tag: 'omnidesk-curator-status',
          renotify: true,
        }
        new Notification('Omnidesk — обновите статусы', opts)
      } catch {
        /* ignore */
      }
    }

    // Immediate reminder when the page loads with pending items.
    notify()
    const id = window.setInterval(notify, INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [hasPending])

  return null
}
