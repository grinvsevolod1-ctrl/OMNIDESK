'use client'

import { useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  FolderPlus,
  Loader2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { SortDir, SortField } from './use-expenses'

/** Inline "add section" affordance: a button that expands into a small form. */
export function AddSectionInline({
  value,
  onChange,
  pending,
  onSubmit,
}: {
  value: string
  onChange: (v: string) => void
  pending: boolean
  onSubmit: () => void
}) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setOpen(true)}
      >
        <FolderPlus className="size-4" /> Вкладка
      </Button>
    )
  }
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Название вкладки"
        className="h-8 w-44"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false)
            onChange('')
          }
        }}
      />
      <Button type="submit" size="sm" disabled={pending || !value.trim()}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-8"
        onClick={() => {
          setOpen(false)
          onChange('')
        }}
      >
        <X className="size-4" />
      </Button>
    </form>
  )
}

/** Sortable table header cell with direction indicator. */
export function SortableTh({
  label,
  field,
  active,
  dir,
  onSort,
  align = 'left',
}: {
  label: string
  field: SortField
  active: SortField
  dir: SortDir
  onSort: (f: SortField) => void
  align?: 'left' | 'right'
}) {
  return (
    <th
      className={cn(
        'px-3 py-2.5 font-medium',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={cn(
          'inline-flex items-center gap-1 hover:text-foreground',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        {label}
        {active === field ? (
          dir === 'asc' ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-50" />
        )}
      </button>
    </th>
  )
}
