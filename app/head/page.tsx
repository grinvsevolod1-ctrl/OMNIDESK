import { requireHead } from '@/lib/auth'
import { getHeadCanEdit, listCuratorsOfHead, listLeadCardsForHead } from '@/lib/data/heads'
import { HeadLeadsView } from '@/components/head/head-leads-view'

export default async function HeadLeadsPage() {
  const user = await requireHead()
  const [leads, curators, canEdit] = await Promise.all([
    listLeadCardsForHead(user.sub),
    listCuratorsOfHead(user.sub),
    getHeadCanEdit(user.sub),
  ])

  return (
    <HeadLeadsView
      initialLeads={leads}
      curators={curators}
      canEdit={canEdit}
    />
  )
}
