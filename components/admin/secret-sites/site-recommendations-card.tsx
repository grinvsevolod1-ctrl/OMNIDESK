'use client'

import type { Dispatch, SetStateAction } from 'react'
import { Lightbulb, Plus } from 'lucide-react'
import { RecommendationCard } from '@/components/admin/secret-sites/recommendation-card'
import type { SiteRecommendation, SiteState } from '@/lib/god-sites'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

/**
 * Optional curated recommendation cards. An empty list serializes without the
 * key at all, so the vitrine falls back to auto-computed recommendations.
 * Also renders the campaign-name datalist that the recommendation binding
 * references by NAME.
 */
export function SiteRecommendationsCard({
  state,
  setState,
  recommendations,
  onPatch,
}: {
  state: SiteState
  setState: Dispatch<SetStateAction<SiteState>>
  recommendations: SiteRecommendation[]
  onPatch: (idx: number, patch: Partial<SiteRecommendation>) => void
}) {
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Lightbulb
            className={`size-4 ${
              recommendations.length > 0
                ? 'text-success'
                : 'text-muted-foreground'
            }`}
          />
          <h2 className="text-sm font-semibold">Рекомендации</h2>
          <span className="text-xs text-muted-foreground">
            {recommendations.length > 0
              ? `— витрина покажет эти ${recommendations.length} шт.`
              : '— пусто: витрина считает рекомендации сама'}
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setState((s) => ({
              ...s,
              recommendations: [
                ...(s.recommendations ?? []),
                {
                  id: `r${Date.now().toString(36)}`,
                  title: '',
                  text: '',
                  category: '',
                  campaign: '',
                  impact: '',
                },
              ],
            }))
          }
          className="press-scale gap-1.5"
        >
          <Plus className="size-4" />
          Добавить рекомендацию
        </Button>
      </div>

      {recommendations.map((rec, idx) => (
        <RecommendationCard
          key={rec.id}
          rec={rec}
          onPatch={(patch) => onPatch(idx, patch)}
          onRemove={() =>
            setState((s) => {
              const next = (s.recommendations ?? []).filter((_, i) => i !== idx)
              return {
                ...s,
                // Drop the key entirely when the list empties, so the
                // payload omits it and the page returns to auto mode.
                ...(next.length > 0
                  ? { recommendations: next }
                  : { recommendations: undefined }),
              }
            })
          }
        />
      ))}
      {/* Campaign-name suggestions for the recommendation binding — the
          contract references campaigns by NAME, so a datalist keeps free
          input possible while nudging toward exact existing names. */}
      <datalist id="site-campaign-names">
        {state.campaigns.map((c) => (
          <option key={c.id} value={c.name} />
        ))}
      </datalist>
    </Card>
  )
}
