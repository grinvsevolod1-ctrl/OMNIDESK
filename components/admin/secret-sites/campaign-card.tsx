'use client'

import { Trash2 } from 'lucide-react'
import type { SiteCampaign } from '@/lib/god-sites'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  CAMPAIGN_NUM_FIELDS,
  CAMPAIGN_TEXT_FIELDS,
  derived,
} from '@/components/admin/secret-sites/site-editor-helpers'

/**
 * Editor for a single campaign row of a managed site: name, run/stop, raw
 * metric inputs and a read-only derived-metrics footer. Stateless — the
 * parent editor owns campaign state and passes patch/remove callbacks, so a
 * long site can map over campaigns without re-rendering the whole form.
 */
export function CampaignCard({
  campaign: c,
  onPatch,
  onRemove,
}: {
  campaign: SiteCampaign
  onPatch: (patch: Partial<SiteCampaign>) => void
  onRemove: () => void
}) {
  return (
    <Card key={c.id} className="flex flex-col gap-0 overflow-hidden p-0">
      {/* Campaign header */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 pb-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Badge
            variant="outline"
            className="shrink-0 font-mono text-xs text-muted-foreground"
            title="Номер кампании (виден на витрине)"
          >
            {c.id}
          </Badge>
          <Input
            value={c.name}
            onChange={(e) => onPatch({ name: e.target.value })}
            className="max-w-md font-medium"
            aria-label="Название кампании"
          />
        </div>
        <div className="flex items-center gap-3">
          <label
            className="flex cursor-pointer items-center gap-2"
            htmlFor={`c-${c.id}-status`}
          >
            <Switch
              id={`c-${c.id}-status`}
              checked={c.status === 'running'}
              onCheckedChange={(v) =>
                onPatch({ status: v ? 'running' : 'stopped' })
              }
            />
            <span
              className={`w-24 text-sm ${
                c.status === 'running'
                  ? 'font-medium text-success'
                  : 'text-muted-foreground'
              }`}
            >
              {c.status === 'running' ? 'Идут показы' : 'Остановлена'}
            </span>
          </label>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (window.confirm(`Удалить кампанию «${c.name}»?`)) {
                onRemove()
              }
            }}
            title="Удалить кампанию"
            className="press-scale size-8 p-0 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {/* Metrics */}
      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {CAMPAIGN_NUM_FIELDS.map((f) => (
            <div key={f.key} className="flex flex-col gap-1.5">
              <Label htmlFor={`c-${c.id}-${f.key}`} className="text-xs">
                {f.label}
              </Label>
              <Input
                id={`c-${c.id}-${f.key}`}
                type="number"
                min={0}
                step="0.01"
                value={c[f.key]}
                onChange={(e) =>
                  onPatch({
                    [f.key]: Number(e.target.value) || 0,
                  } as Partial<SiteCampaign>)
                }
                className="font-mono"
              />
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CAMPAIGN_TEXT_FIELDS.map((f) => (
            <div key={f.key} className="flex flex-col gap-1.5">
              <Label htmlFor={`c-${c.id}-${f.key}`} className="text-xs">
                {f.label}
              </Label>
              <Input
                id={`c-${c.id}-${f.key}`}
                value={c[f.key]}
                placeholder={f.placeholder}
                onChange={(e) =>
                  onPatch({
                    [f.key]: e.target.value,
                  } as Partial<SiteCampaign>)
                }
              />
            </div>
          ))}
        </div>
      </div>

      {/* Derived preview — what the vitrine will render from these numbers */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t bg-muted/40 px-4 py-2.5">
        <span className="text-xs text-muted-foreground">На витрине:</span>
        {derived(c).map((m) => (
          <span key={m.label} className="text-xs">
            <span className="text-muted-foreground">{m.label} </span>
            <span className="font-mono font-medium">{m.value}</span>
          </span>
        ))}
      </div>
    </Card>
  )
}
