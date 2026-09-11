'use server'

import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/auth'
import { isGodUnlocked } from '@/lib/god-gate'
import { getChannelById } from '@/lib/data'
import { generateBase, varyForGroup } from '@/lib/broadcast/draft'
import {
  countTargetsByStatus,
  createCampaign,
  getCampaign,
  getLatestCampaignForChannel,
  listTargets,
  removeTarget,
  setCampaignBaseText,
  setCampaignStatus,
  setTargetDraft,
  setTargetStatus,
  type BroadcastCampaign,
  type BroadcastTarget,
  type TargetStatus,
} from '@/lib/data/broadcast'

/* ===================================================================== */
/*  Рассылка по группам — god-панель, вкладка «Telegram» (личный аккаунт) */
/* ===================================================================== */

/**
 * Гейт: admin-сессия И god-разблокировка (как у telegram-personal actions).
 * Заблокированный/ненастроенный гейт → 404. Сознательно без audit()-следов
 * (СВЯЩЕННЫЙ ИНВАРИАНТ, AGENTS.md §4).
 */
async function requireGod(): Promise<void> {
  await requireAdmin()
  if (!(await isGodUnlocked())) notFound()
}

/** Канал существует И это именно личный аккаунт. Иначе — 404. */
async function requirePersonalChannel(channelId: string): Promise<void> {
  const channel = await getChannelById(channelId)
  if (!channel || channel.type !== 'telegram_personal') notFound()
}

/** Кампания существует И принадлежит личному каналу. Иначе — 404. */
async function requireCampaign(campaignId: string): Promise<BroadcastCampaign> {
  const campaign = await getCampaign(campaignId)
  if (!campaign) notFound()
  await requirePersonalChannel(campaign.channelId)
  return campaign
}

export interface BroadcastView {
  campaign: BroadcastCampaign | null
  targets: BroadcastTarget[]
  counts: Record<TargetStatus, number>
}

/** Snapshot for the panel: latest campaign of a personal channel + targets. */
export async function getBroadcastViewAction(
  channelId: string,
): Promise<BroadcastView> {
  await requireGod()
  await requirePersonalChannel(channelId)
  const campaign = await getLatestCampaignForChannel(channelId)
  if (!campaign) return { campaign: null, targets: [], counts: emptyCounts() }
  const [targets, counts] = await Promise.all([
    listTargets(campaign.id),
    countTargetsByStatus(campaign.id),
  ])
  return { campaign, targets, counts }
}

/**
 * Create a draft campaign from the owner's context + raw group inputs, then
 * generate the base post immediately so the owner can review/edit it.
 */
export async function createBroadcastAction(input: {
  channelId: string
  context: string
  rawInputs: string[]
  captchaReply?: string
  minDelaySec?: number
  maxDelaySec?: number
}): Promise<BroadcastView> {
  await requireGod()
  await requirePersonalChannel(input.channelId)

  const context = input.context.trim()
  if (!context) throw new Error('Контекст сообщения не может быть пустым')
  if (input.rawInputs.filter((r) => r.trim()).length === 0) {
    throw new Error('Добавьте хотя бы одну группу')
  }

  const campaign = await createCampaign({
    channelId: input.channelId,
    context,
    captchaReply: input.captchaReply?.trim() || undefined,
    minDelaySec: clampDelay(input.minDelaySec, 45),
    maxDelaySec: clampDelay(input.maxDelaySec, 90),
    rawInputs: input.rawInputs,
  })

  const base = await generateBase(context)
  await setCampaignBaseText(campaign.id, base)

  return getBroadcastViewAction(input.channelId)
}

/** Regenerate the base post from the stored context (owner asked for a redo). */
export async function regenerateBaseAction(
  campaignId: string,
): Promise<string> {
  await requireGod()
  const campaign = await requireCampaign(campaignId)
  assertEditable(campaign)
  const base = await generateBase(campaign.context)
  await setCampaignBaseText(campaignId, base)
  return base
}

/** Owner-edited base post text (manual override before generating variants). */
export async function saveBaseTextAction(
  campaignId: string,
  baseText: string,
): Promise<void> {
  await requireGod()
  const campaign = await requireCampaign(campaignId)
  assertEditable(campaign)
  await setCampaignBaseText(campaignId, baseText.trim())
}

/**
 * Generate a UNIQUE per-group variant for every target (anti-spam). Runs
 * sequentially with a small concurrency cap so we don't hammer the gateway.
 */
export async function generateVariantsAction(
  campaignId: string,
): Promise<BroadcastTarget[]> {
  await requireGod()
  const campaign = await requireCampaign(campaignId)
  assertEditable(campaign)
  if (!campaign.baseText.trim()) {
    throw new Error('Сначала сформируйте базовый текст')
  }

  const targets = await listTargets(campaignId)
  // Small batches keep gateway pressure and latency reasonable for 50+ groups.
  const BATCH = 4
  for (let i = 0; i < targets.length; i += BATCH) {
    const slice = targets.slice(i, i + BATCH)
    await Promise.all(
      slice.map(async (t) => {
        const title = t.resolvedTitle || t.rawInput
        const variant = await varyForGroup(campaign.baseText, title)
        await setTargetDraft(t.id, variant)
      }),
    )
  }
  return listTargets(campaignId)
}

/** Owner-edited variant for a single group. */
export async function saveVariantAction(
  campaignId: string,
  targetId: string,
  text: string,
): Promise<void> {
  await requireGod()
  const campaign = await requireCampaign(campaignId)
  assertEditable(campaign)
  await setTargetDraft(targetId, text.trim())
}

export async function removeTargetAction(
  campaignId: string,
  targetId: string,
): Promise<void> {
  await requireGod()
  const campaign = await requireCampaign(campaignId)
  assertEditable(campaign)
  await removeTarget(targetId)
}

/** Skip a single group without deleting it (kept for the audit-free record). */
export async function skipTargetAction(
  campaignId: string,
  targetId: string,
): Promise<void> {
  await requireGod()
  await requireCampaign(campaignId)
  await setTargetStatus(targetId, 'skipped')
}

/**
 * Launch (or resume) the campaign: the SINGLE approval button for the whole
 * broadcast. The worker runner picks it up on its next tick.
 */
export async function startBroadcastAction(campaignId: string): Promise<void> {
  await requireGod()
  const campaign = await requireCampaign(campaignId)
  if (!campaign.baseText.trim()) {
    throw new Error('Нет текста для рассылки')
  }
  await setCampaignStatus(campaignId, 'running')
}

export async function pauseBroadcastAction(campaignId: string): Promise<void> {
  await requireGod()
  await requireCampaign(campaignId)
  await setCampaignStatus(campaignId, 'paused')
}

/* -------------------------------- Helpers --------------------------------- */

/** Editing (text/variants/targets) is only allowed before the run starts. */
function assertEditable(campaign: BroadcastCampaign): void {
  if (campaign.status === 'running') {
    throw new Error('Рассылка запущена — сначала поставьте на паузу')
  }
}

function clampDelay(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback
  return Math.max(10, Math.min(3600, Math.round(value)))
}

function emptyCounts(): Record<TargetStatus, number> {
  return {
    pending: 0,
    joining: 0,
    verifying: 0,
    sending: 0,
    sent: 0,
    needs_attention: 0,
    failed: 0,
    skipped: 0,
  }
}
