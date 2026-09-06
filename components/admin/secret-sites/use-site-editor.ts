'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  secretDownloadExtensionAction,
  secretGetSiteAction,
  secretSaveSiteStateAction,
  secretSetSiteBlockedAction,
  secretTopUpSiteAction,
} from '@/app/actions/admin-secret'
import { downloadBase64Zip } from '@/components/admin/secret-sites/download-zip'
import {
  dropOverridesFor,
  newCampaign,
  nf,
  previewDayFraction,
} from '@/components/admin/secret-sites/site-editor-helpers'
import type {
  GodSite,
  PeriodMetricField,
  SiteCampaign,
  SitePeriod,
  SiteRecommendation,
  SiteState,
} from '@/lib/god-sites'

/**
 * All state and handlers behind the site editor. Kept in a hook so the editor
 * shell stays a thin composition of presentational cards. Saves the whole
 * state atomically under optimistic locking — a stale save answers a conflict
 * and the operator reopens (or reloads in place) with fresh data.
 */
export function useSiteEditor(site: GodSite, onClose: () => void) {
  const [pending, startTransition] = useTransition()
  const [state, setState] = useState<SiteState>(site.state)
  const [revision, setRevision] = useState(site.revision)
  const [conflict, setConflict] = useState(false)
  const [savedSnapshot, setSavedSnapshot] = useState(() =>
    JSON.stringify(site.state),
  )
  const dirty = useMemo(
    () => JSON.stringify(state) !== savedSnapshot,
    [state, savedSnapshot],
  )
  const running = state.campaigns.filter((c) => c.status === 'running').length
  const autoEnabled = state.autoSpend?.enabled === true
  const autoPreviewFraction = useMemo(
    () => previewDayFraction(state.autoSpend),
    [state.autoSpend],
  )
  const [topUpAmount, setTopUpAmount] = useState('')
  // Balance the vitrine shows right now: stored minus today's partial burn.
  // Same curve as the server (god-sites-sim is shared) — an estimate only in
  // the rare capped case when the balance runs out mid-day.
  const vitrineBalance = autoEnabled
    ? Math.max(
        0,
        state.balance -
          Math.min(
            autoPreviewFraction * (state.autoSpend?.dailyBudget ?? 0),
            state.balance,
          ),
      )
    : state.balance

  const recommendations = state.recommendations ?? []

  // The «Назад» button already guards a dirty exit, but browser navigation
  // (reload, tab close, back gesture) bypassed it and silently dropped the
  // draft. beforeunload closes that hole for reload/close.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Chrome requires returnValue to be set for the prompt to appear.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  function patchCampaign(idx: number, patch: Partial<SiteCampaign>) {
    setState((s) => ({
      ...s,
      campaigns: s.campaigns.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    }))
  }

  function patchRecommendation(idx: number, patch: Partial<SiteRecommendation>) {
    setState((s) => ({
      ...s,
      recommendations: (s.recommendations ?? []).map((r, i) =>
        i === idx ? { ...r, ...patch } : r,
      ),
    }))
  }

  /**
   * Set or clear ONE per-period metric override for a campaign. Empty maps
   * collapse upward (override → campaign → period → the whole key), so a
   * fully-cleared state serializes without `periodOverrides` at all — same
   * shape the validator produces, keeping the dirty check honest.
   */
  function patchOverride(
    campaignId: string,
    period: SitePeriod,
    field: PeriodMetricField,
    value: number | undefined,
  ) {
    setState((s) => {
      const po = { ...(s.periodOverrides ?? {}) }
      const byId = { ...(po[period] ?? {}) }
      const ov = { ...(byId[campaignId] ?? {}) }
      if (value === undefined) delete ov[field]
      else ov[field] = value
      if (Object.keys(ov).length > 0) byId[campaignId] = ov
      else delete byId[campaignId]
      if (Object.keys(byId).length > 0) po[period] = byId
      else delete po[period]
      return {
        ...s,
        ...(Object.keys(po).length > 0
          ? { periodOverrides: po }
          : { periodOverrides: undefined }),
      }
    })
  }

  /**
   * Duplicate a campaign: fresh id, «(копия)» suffix, stopped by default so
   * the vitrine doesn't instantly show two identical running campaigns.
   * Period overrides are copied too — the typical use is "same campaign,
   * different region", where curated history should carry over.
   */
  function duplicateCampaign(idx: number) {
    setState((s) => {
      const src = s.campaigns[idx]
      if (!src) return s
      const copy: SiteCampaign = {
        ...src,
        id: newCampaign().id,
        name: `${src.name} (копия)`,
        status: 'stopped',
      }
      const campaigns = [
        ...s.campaigns.slice(0, idx + 1),
        copy,
        ...s.campaigns.slice(idx + 1),
      ]
      if (!s.periodOverrides) return { ...s, campaigns }
      const po = { ...s.periodOverrides }
      for (const period of Object.keys(po) as SitePeriod[]) {
        const byId = po[period]
        if (byId?.[src.id]) {
          po[period] = { ...byId, [copy.id]: { ...byId[src.id] } }
        }
      }
      return { ...s, campaigns, periodOverrides: po }
    })
  }

  /** Remove a campaign and every period override that referenced it. */
  function removeCampaign(idx: number) {
    setState((s) => {
      const target = s.campaigns[idx]
      const campaigns = s.campaigns.filter((_, i) => i !== idx)
      const next = { ...s, campaigns }
      return target ? dropOverridesFor(next, target.id) : next
    })
  }

  function back() {
    if (
      dirty &&
      !window.confirm('Есть несохранённые изменения. Выйти без сохранения?')
    ) {
      return
    }
    onClose()
  }

  /**
   * Build & download the browser extension for THIS site. Downloads do NOT
   * rotate the API key (migration 137): the permanent token is baked in and
   * every archive ever downloaded keeps working. The only warning left is
   * about unsaved edits — the extension reads live state from the API, but
   * the operator likely expects their draft to be visible right away.
   */
  function downloadExtension() {
    if (
      dirty &&
      !window.confirm(
        'Есть несохранённые изменения — витрина покажет последнее сохранённое состояние, пока вы не нажмёте «Сохранить всё». Продолжить?',
      )
    ) {
      return
    }
    startTransition(async () => {
      try {
        const res = await secretDownloadExtensionAction(site.id)
        if (res.ok && res.base64 && res.fileName) {
          downloadBase64Zip(res.base64, res.fileName)
          toast.success(res.message)
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Не удалось собрать расширение')
      }
    })
  }

  function save() {
    startTransition(async () => {
      try {
        const res = await secretSaveSiteStateAction(site.id, state, revision)
        if (res.ok) {
          setSavedSnapshot(JSON.stringify(state))
          toast.success(res.message)
          onClose()
        } else {
          if (res.conflict) setConflict(true)
          toast.error(res.message)
        }
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
    })
  }

  /**
   * Top-up: the server atomically ADDS to the stored balance (after banking
   * pending rollover days), then we adopt the fresh balance + revision in
   * place — other unsaved edits survive, and the next save won't conflict.
   */
  function topUp() {
    const amount = Number(topUpAmount.replace(',', '.'))
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Введите сумму пополнения больше нуля')
      return
    }
    startTransition(async () => {
      try {
        const res = await secretTopUpSiteAction(site.id, amount)
        if (!res.ok || res.balance === undefined || res.revision === undefined) {
          toast.error(res.message)
          return
        }
        setRevision(res.revision)
        setState((s) => ({ ...s, balance: res.balance as number }))
        // The new balance is already persisted — sync the snapshot so the
        // top-up alone doesn't flag the editor as dirty.
        setSavedSnapshot((snap) => {
          try {
            const parsed = JSON.parse(snap) as SiteState
            return JSON.stringify({ ...parsed, balance: res.balance })
          } catch {
            return snap
          }
        })
        setTopUpAmount('')
        toast.success(
          `Баланс пополнен: ${nf.format(res.balance)} ${state.currency}`,
        )
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
    })
  }

  /**
   * «Аккаунт заблокирован» kill switch — instant server flip (same pattern
   * as the top-up: no revision race, snapshot synced in place so the toggle
   * alone never flags the editor dirty). The vitrine wipes itself to the
   * white blocked screen at its next poll/SSE tick.
   */
  function toggleBlocked() {
    const next = state.blocked !== true
    if (
      next &&
      !window.confirm(
        'Заблокировать аккаунт? Витрина заменит ВЕСЬ контент белой страницей «Аккаунт заблокирован».',
      )
    ) {
      return
    }
    startTransition(async () => {
      try {
        const res = await secretSetSiteBlockedAction(site.id, next)
        if (!res.ok || res.revision === undefined) {
          toast.error(res.message)
          return
        }
        setRevision(res.revision)
        setState((s) => {
          const { blocked: _prev, ...rest } = s
          return next ? { ...rest, blocked: true } : rest
        })
        // The flip is already persisted — sync the snapshot so it doesn't
        // flag the editor dirty (mirrors the top-up flow).
        setSavedSnapshot((snap) => {
          try {
            const { blocked: _prev, ...rest } = JSON.parse(snap) as SiteState
            return JSON.stringify(next ? { ...rest, blocked: true } : rest)
          } catch {
            return snap
          }
        })
        toast.success(res.message)
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
    })
  }

  /**
   * Conflict recovery: pull the fresh state + revision in place, discarding
   * local edits — no need to close and reopen the editor.
   */
  function reloadFresh() {
    startTransition(async () => {
      try {
        const fresh = await secretGetSiteAction(site.id)
        if (!fresh) {
          toast.error('Сайт не найден — возможно, удалён')
          onClose()
          return
        }
        setState(fresh.state)
        setRevision(fresh.revision)
        setSavedSnapshot(JSON.stringify(fresh.state))
        setConflict(false)
        toast.success('Данные перезагружены')
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
    })
  }

  return {
    state,
    setState,
    conflict,
    dirty,
    pending,
    running,
    autoEnabled,
    autoPreviewFraction,
    vitrineBalance,
    recommendations,
    topUpAmount,
    setTopUpAmount,
    patchCampaign,
    patchRecommendation,
    patchOverride,
    duplicateCampaign,
    removeCampaign,
    back,
    downloadExtension,
    save,
    topUp,
    toggleBlocked,
    reloadFresh,
  }
}
