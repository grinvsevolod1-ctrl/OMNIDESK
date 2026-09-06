'use client'

import type { GodSite } from '@/lib/god-sites'
import { useSiteEditor } from '@/components/admin/secret-sites/use-site-editor'
import { SiteEditorHeader } from '@/components/admin/secret-sites/site-editor-header'
import { SiteCabinetCard } from '@/components/admin/secret-sites/site-cabinet-card'
import { SiteAutoSpendCard } from '@/components/admin/secret-sites/site-autospend-card'
import { SiteRecommendationsCard } from '@/components/admin/secret-sites/site-recommendations-card'
import { SiteCampaignsSection } from '@/components/admin/secret-sites/site-campaigns-section'

/**
 * Full cabinet-state editor for a managed external site: login, balance,
 * currency and every field of every campaign. All state lives in
 * useSiteEditor; this shell just composes the presentational cards. Saves the
 * whole state atomically under optimistic locking — a stale save answers a
 * conflict and the operator reopens (or reloads in place) with fresh data.
 */
export function SiteEditor({
  site,
  onClose,
}: {
  site: GodSite
  onClose: () => void
}) {
  const editor = useSiteEditor(site, onClose)

  return (
    <div className="flex flex-col gap-4">
      <SiteEditorHeader
        site={site}
        state={editor.state}
        dirty={editor.dirty}
        pending={editor.pending}
        conflict={editor.conflict}
        onBack={editor.back}
        onToggleBlocked={editor.toggleBlocked}
        onDownloadExtension={editor.downloadExtension}
        onSave={editor.save}
        onReloadFresh={editor.reloadFresh}
      />

      <SiteCabinetCard
        state={editor.state}
        setState={editor.setState}
        autoEnabled={editor.autoEnabled}
        vitrineBalance={editor.vitrineBalance}
        topUpAmount={editor.topUpAmount}
        setTopUpAmount={editor.setTopUpAmount}
        onTopUp={editor.topUp}
        pending={editor.pending}
      />

      <SiteAutoSpendCard
        state={editor.state}
        setState={editor.setState}
        autoEnabled={editor.autoEnabled}
        autoPreviewFraction={editor.autoPreviewFraction}
      />

      <SiteRecommendationsCard
        state={editor.state}
        setState={editor.setState}
        recommendations={editor.recommendations}
        onPatch={editor.patchRecommendation}
      />

      <SiteCampaignsSection
        state={editor.state}
        setState={editor.setState}
        onPatchCampaign={editor.patchCampaign}
        onPatchOverride={editor.patchOverride}
        onDuplicate={editor.duplicateCampaign}
        onRemove={editor.removeCampaign}
      />
    </div>
  )
}
