'use client'

/**
 * City input with dictionary suggestions (datalist-based, zero deps).
 * Suggestions come from the cities dictionary (migration 115) via
 * suggestCitiesAction, debounced through SWR keyed on the typed prefix.
 */
import { useId, useState } from 'react'
import useSWR from 'swr'
import { suggestCitiesAction } from '@/app/actions/managers'
import { Input } from '@/components/ui/input'

export function CityInput({
  id,
  name,
  defaultValue,
  value,
  onValueChange,
  placeholder = 'Москва',
  required,
  className,
}: {
  id?: string
  name?: string
  defaultValue?: string
  value?: string
  onValueChange?: (v: string) => void
  placeholder?: string
  required?: boolean
  className?: string
}) {
  const listId = useId()
  // For uncontrolled usage we still track the query to drive suggestions.
  const [query, setQuery] = useState(defaultValue ?? '')
  const q = (value ?? query).trim()

  const { data: options } = useSWR(
    ['city-suggest', q.toLowerCase()],
    () => suggestCitiesAction(q || undefined),
    { keepPreviousData: true, revalidateOnFocus: false },
  )

  return (
    <>
      <Input
        id={id}
        name={name}
        type="text"
        list={listId}
        autoComplete="off"
        placeholder={placeholder}
        required={required}
        className={className}
        {...(value !== undefined
          ? {
              value,
              onChange: (e) => onValueChange?.(e.target.value),
            }
          : {
              defaultValue,
              onChange: (e) => setQuery(e.target.value),
            })}
      />
      <datalist id={listId}>
        {(options ?? []).map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </>
  )
}
