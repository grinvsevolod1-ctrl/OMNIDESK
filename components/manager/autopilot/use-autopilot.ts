'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  createRuleAction,
  deleteRuleAction,
  reorderRulesAction,
  setAutopilotEnabledAction,
  setRuleEnabledAction,
  updateRuleAction,
} from '@/app/actions/autopilot'
import type { AutopilotRule } from '@/lib/autopilot/match'
import { draftToPayload, type DraftState } from './draft'

/**
 * All client-side state and server-action plumbing for the autopilot manager:
 * master switch, rule CRUD with optimistic updates and rollback on failure,
 * and drag-free reordering. The component stays purely presentational.
 */
export function useAutopilot(initialEnabled: boolean, initialRules: AutopilotRule[]) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [rules, setRules] = useState<AutopilotRule[]>(initialRules)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const enabledCount = rules.filter((r) => r.enabled).length

  function toggleMaster(next: boolean) {
    setEnabled(next) // optimistic
    startTransition(async () => {
      const res = await setAutopilotEnabledAction(next)
      if (!res.ok) {
        setEnabled(!next)
        toast.error(res.message)
        return
      }
      toast.success(res.message)
    })
  }

  function create(draft: DraftState) {
    startTransition(async () => {
      const res = await createRuleAction(draftToPayload(draft))
      if (!res.ok || !res.rule) {
        toast.error(res.message)
        return
      }
      setRules((prev) => [...prev, res.rule as AutopilotRule])
      setCreating(false)
      toast.success(res.message)
    })
  }

  function update(id: string, draft: DraftState) {
    startTransition(async () => {
      const res = await updateRuleAction(id, draftToPayload(draft))
      if (!res.ok || !res.rule) {
        toast.error(res.message)
        return
      }
      setRules((prev) => prev.map((r) => (r.id === id ? (res.rule as AutopilotRule) : r)))
      setEditingId(null)
      toast.success(res.message)
    })
  }

  function toggleRule(id: string, next: boolean) {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled: next } : r)))
    startTransition(async () => {
      const res = await setRuleEnabledAction(id, next)
      if (!res.ok) {
        setRules((prev) =>
          prev.map((r) => (r.id === id ? { ...r, enabled: !next } : r)),
        )
        toast.error(res.message)
      }
    })
  }

  function remove(id: string) {
    const prev = rules
    setRules((list) => list.filter((r) => r.id !== id))
    startTransition(async () => {
      const res = await deleteRuleAction(id)
      if (!res.ok) {
        setRules(prev)
        toast.error(res.message)
        return
      }
      toast.success(res.message)
    })
  }

  function move(index: number, dir: -1 | 1) {
    const next = [...rules]
    const target = index + dir
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setRules(next)
    const orderedIds = next.map((r) => r.id)
    startTransition(async () => {
      const res = await reorderRulesAction(orderedIds)
      if (!res.ok) toast.error(res.message)
    })
  }

  return {
    enabled,
    rules,
    creating,
    setCreating,
    editingId,
    setEditingId,
    pending,
    enabledCount,
    toggleMaster,
    create,
    update,
    toggleRule,
    remove,
    move,
  }
}
