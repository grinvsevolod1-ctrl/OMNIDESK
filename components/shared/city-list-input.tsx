'use client'

/**
 * Multi-city editor: one input per city + "add city" button.
 * The first row is the primary city. Submits a comma-joined value through a
 * hidden input (server side already parses comma lists via parseCityList),
 * so existing actions keep working unchanged.
 */
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CityInput } from '@/components/shared/city-input'

export function CityListInput({
  idPrefix,
  name,
  cities,
  onChange,
  required,
}: {
  idPrefix: string
  /** When set, a hidden input submits the comma-joined list via FormData. */
  name?: string
  cities: string[]
  onChange: (next: string[]) => void
  required?: boolean
}) {
  const rows = cities.length > 0 ? cities : ['']
  const joined = rows
    .map((c) => c.trim())
    .filter(Boolean)
    .join(', ')

  function setCity(index: number, value: string) {
    const next = [...rows]
    next[index] = value
    onChange(next)
  }

  function removeCity(index: number) {
    const next = rows.filter((_, i) => i !== index)
    onChange(next.length > 0 ? next : [''])
  }

  return (
    <div className="flex flex-col gap-2">
      {name ? <input type="hidden" name={name} value={joined} /> : null}
      {rows.map((city, i) => (
        <div key={i} className="flex items-center gap-2">
          <CityInput
            id={i === 0 ? idPrefix : `${idPrefix}-${i}`}
            value={city}
            onValueChange={(v) => setCity(i, v)}
            placeholder={i === 0 ? 'Москва' : 'Ещё город'}
            required={required && i === 0}
            className="flex-1"
          />
          {rows.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => removeCity(i)}
              aria-label={`Убрать город ${city || i + 1}`}
            >
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange([...rows, ''])}
      >
        <Plus className="size-4" />
        Добавить город
      </Button>
      <p className="text-xs text-muted-foreground">
        Первый город — основной. Лиды подбираются по любому из указанных.
      </p>
    </div>
  )
}
