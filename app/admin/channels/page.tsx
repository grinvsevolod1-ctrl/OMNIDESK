import { redirect } from 'next/navigation'

// «Все каналы» объединены с обзорной страницей аккаунтов. Сохраняем маршрут,
// чтобы старые ссылки и закладки не давали 404.
export default function AdminChannelsPage() {
  redirect('/admin/accounts')
}
