'use client'

import { Trash2 } from 'lucide-react'
import type { SiteRecommendation } from '@/lib/god-sites'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

/**
 * Editor for one curated recommendation card of a managed site. Stateless:
 * the parent owns the list (including the "drop the key entirely when the
 * list empties" rule that returns the vitrine to auto mode), so this card
 * only patches its own fields or asks to be removed.
 */
export function RecommendationCard({
  rec,
  onPatch,
  onRemove,
}: {
  rec: SiteRecommendation
  onPatch: (patch: Partial<SiteRecommendation>) => void
  onRemove: () => void
}) {
  return (
    <div
      key={rec.id}
      className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3"
    >
      <div className="flex items-start gap-3">
        <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`rec-${rec.id}-title`} className="text-xs">
              Заголовок
            </Label>
            <Input
              id={`rec-${rec.id}-title`}
              value={rec.title}
              placeholder="Повысьте CTR объявлений"
              onChange={(e) => onPatch({ title: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`rec-${rec.id}-impact`} className="text-xs">
              Эффект
            </Label>
            <Input
              id={`rec-${rec.id}-impact`}
              value={rec.impact}
              placeholder="+15% конверсий"
              onChange={(e) => onPatch({ impact: e.target.value })}
            />
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={onRemove}
          title="Удалить рекомендацию"
          className="press-scale mt-6 size-8 shrink-0 p-0 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`rec-${rec.id}-text`} className="text-xs">
          Текст
        </Label>
        <Textarea
          id={`rec-${rec.id}-text`}
          value={rec.text}
          rows={2}
          placeholder="Добавьте быстрые ссылки и уточнения в объявления."
          onChange={(e) => onPatch({ text: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`rec-${rec.id}-category`} className="text-xs">
            Категория
          </Label>
          <Input
            id={`rec-${rec.id}-category`}
            value={rec.category}
            placeholder="Объявления / Ставки / Бюджет…"
            onChange={(e) => onPatch({ category: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`rec-${rec.id}-campaign`} className="text-xs">
            Кампания (пусто = весь аккаунт)
          </Label>
          <Input
            id={`rec-${rec.id}-campaign`}
            value={rec.campaign}
            list="site-campaign-names"
            placeholder="Название кампании"
            onChange={(e) => onPatch({ campaign: e.target.value })}
          />
        </div>
      </div>
    </div>
  )
}
