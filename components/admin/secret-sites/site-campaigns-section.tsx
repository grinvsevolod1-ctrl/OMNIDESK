'use client'

import type { Dispatch, SetStateAction } from 'react'
import { CircleDot, Plus } from 'lucide-react'
import { CampaignCard } from '@/components/admin/secret-sites/campaign-card'
import { newCampaign } from '@/components/admin/secret-sites/site-editor-helpers'
import type {
  PeriodMetricField,
  SiteCampaign,
  SitePeriod,
  SiteState,
} from '@/lib/god-sites'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

/**
 * The campaign list: add button, empty state and one CampaignCard per
 * campaign, each wired to per-field and per-period-override patch callbacks
 * plus duplicate/remove.
 */
export function SiteCampaignsSection({
  state,
  setState,
  onPatchCampaign,
  onPatchOverride,
  onDuplicate,
  onRemove,
}: {
  state: SiteState
  setState: Dispatch<SetStateAction<SiteState>>
  onPatchCampaign: (idx: number, patch: Partial<SiteCampaign>) => void
  onPatchOverride: (
    campaignId: string,
    period: SitePeriod,
    field: PeriodMetricField,
    value: number | undefined,
  ) => void
  onDuplicate: (idx: number) => void
  onRemove: (idx: number) => void
}) {
  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CircleDot className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Кампании</h2>
          <Badge variant="outline" className="font-mono text-xs">
            {state.campaigns.length}
          </Badge>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setState((s) => ({ ...s, campaigns: [...s.campaigns, newCampaign()] }))
          }
          className="press-scale gap-1.5"
        >
          <Plus className="size-4" />
          Добавить кампанию
        </Button>
      </div>

      {state.campaigns.length === 0 && (
        <Card className="flex flex-col items-center gap-1 p-8 text-center">
          <p className="text-sm font-medium">Кампаний пока нет</p>
          <p className="text-sm text-muted-foreground">
            Витрина покажет пустой список — добавьте первую кампанию.
          </p>
        </Card>
      )}

      {state.campaigns.map((c, idx) => (
        <CampaignCard
          key={c.id}
          campaign={c}
          overrides={Object.fromEntries(
            Object.entries(state.periodOverrides ?? {}).map(
              ([period, byId]) => [period, byId?.[c.id]],
            ),
          )}
          onPatch={(patch) => onPatchCampaign(idx, patch)}
          onOverridePatch={(period, field, value) =>
            onPatchOverride(c.id, period, field, value)
          }
          onDuplicate={() => onDuplicate(idx)}
          onRemove={() => onRemove(idx)}
        />
      ))}
    </>
  )
}
