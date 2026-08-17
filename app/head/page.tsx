import { requireHead } from '@/lib/auth'
import {
  getHeadCanEdit,
  listCuratorsOfHead,
  listLeadCardsForHead,
  listManagersOfHead,
} from '@/lib/data/heads'
import { HeadLeadsView } from '@/components/head/head-leads-view'

export default async function HeadLeadsPage() {
  const user = await requireHead()
  const [leads, curators, managers, canEdit] = await Promise.all([
    listLeadCardsForHead(user.sub),
    listCuratorsOfHead(user.sub),
    listManagersOfHead(user.sub),
    getHeadCanEdit(user.sub),
  ])

  return (
    <HeadLeadsView
      initialLeads={leads}
      curators={curators}
      managers={managers}
      canEdit={canEdit}
    />
  )
}
