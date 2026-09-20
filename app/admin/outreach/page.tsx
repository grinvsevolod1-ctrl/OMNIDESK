import { SecretOutreachTab } from '@/components/admin/secret-outreach/outreach-tab'

/**
 * Раздел «Исходящие» обычной админки: отдельный Telegram API-контур для
 * исходящих касаний (пул API-ключей, бот-приёмник лидов, пул боевых аккаунтов
 * с прогревом и анти-баном). Экшены под ним гейтятся requireAdmin().
 */
export default function AdminOutreachPage() {
  return <SecretOutreachTab />
}
