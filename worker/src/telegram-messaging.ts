import { Api, type TelegramClient } from 'telegram'

/**
 * Outgoing message operations (send / read / typing / react / delete / edit /
 * forward), extracted from the TelegramSession monolith. Each function is a
 * thin GramJS invocation over the live client; throttling and flood-cooldown
 * remain the session's responsibility and are injected via `deps`.
 */
export interface TgMessagingDeps {
  getClient: () => TelegramClient | null
  resolveTarget: (target: string) => Promise<Api.TypeInputPeer | string>
  /** Per-account send pacing — shared by text sends, forwards, stickers. */
  throttleSend: () => Promise<void>
  /** Enter flood cooldown when Telegram returns FLOOD_WAIT. */
  tripFloodCooldown: (err: unknown) => void
}

function requireClient(deps: TgMessagingDeps): TelegramClient {
  const client = deps.getClient()
  if (!client) throw new Error('Session not started')
  return client
}

export async function sendMessageTo(
  deps: TgMessagingDeps,
  target: string,
  body: string,
  opts?: { replyToMsgId?: number; scheduleAt?: number },
): Promise<{ providerMessageId: string | null }> {
  const client = requireClient(deps)
  await deps.throttleSend()
  try {
    const entity = await deps.resolveTarget(target)
    const sent = await client.sendMessage(entity, {
      message: body,
      ...(opts?.replyToMsgId ? { replyTo: opts.replyToMsgId } : {}),
      ...(opts?.scheduleAt ? { schedule: opts.scheduleAt } : {}),
    })
    return { providerMessageId: sent?.id != null ? String(sent.id) : null }
  } catch (err) {
    deps.tripFloodCooldown(err)
    throw err
  }
}

/**
 * Send read receipts for a chat (marks the whole history read), so the
 * contact sees that the operator read their messages. Best-effort.
 */
export async function markReadIn(
  deps: TgMessagingDeps,
  target: string,
): Promise<void> {
  const client = requireClient(deps)
  const entity = await deps.resolveTarget(target)
  await client.markAsRead(entity)
}

/**
 * Show or cancel the "typing…" indicator. Telegram auto-expires the indicator
 * after ~6s, so callers re-send it while the operator keeps typing.
 * `on=false` sends an explicit cancel action instead of waiting for expiry.
 */
export async function setTypingIn(
  deps: TgMessagingDeps,
  target: string,
  on: boolean,
): Promise<void> {
  const client = requireClient(deps)
  const entity = await deps.resolveTarget(target)
  await client.invoke(
    new Api.messages.SetTyping({
      peer: entity,
      action: on
        ? new Api.SendMessageTypingAction()
        : new Api.SendMessageCancelAction(),
    }),
  )
}

/**
 * Toggle an emoji reaction on a message. Passing an empty emoji clears the
 * reaction. Telegram-only.
 */
export async function reactToMessageIn(
  deps: TgMessagingDeps,
  target: string,
  msgId: number,
  emoji: string,
): Promise<void> {
  const client = requireClient(deps)
  const entity = await deps.resolveTarget(target)
  await client.invoke(
    new Api.messages.SendReaction({
      peer: entity,
      msgId,
      reaction: emoji
        ? [new Api.ReactionEmoji({ emoticon: emoji })]
        : [new Api.ReactionEmpty()],
    }),
  )
}

/**
 * Delete a message. `revoke` deletes it for everyone (both sides) rather than
 * only for this account. Telegram-only.
 */
export async function deleteMessageIn(
  deps: TgMessagingDeps,
  target: string,
  msgId: number,
  revoke = true,
): Promise<void> {
  const client = requireClient(deps)
  const entity = await deps.resolveTarget(target)
  await client.deleteMessages(entity, [msgId], { revoke })
}

/**
 * Edit the text of an already-sent message (Telegram only). The contact sees
 * the native "edited" mark, exactly like editing in the official client.
 */
export async function editMessageIn(
  deps: TgMessagingDeps,
  target: string,
  msgId: number,
  body: string,
): Promise<void> {
  const client = requireClient(deps)
  const entity = await deps.resolveTarget(target)
  await client.editMessage(entity, { message: msgId, text: body })
}

/**
 * Forward a message from one chat to another. Returns the new Telegram
 * message id in the destination chat. Telegram-only.
 *
 * Forwards are outgoing sends like any other: they must respect the same
 * per-account pacing and flood gate — this used to bypass both.
 */
export async function forwardMessageIn(
  deps: TgMessagingDeps,
  fromTarget: string,
  msgId: number,
  toTarget: string,
): Promise<{ providerMessageId: string | null }> {
  const client = requireClient(deps)
  await deps.throttleSend()
  try {
    const fromEntity = await deps.resolveTarget(fromTarget)
    const toEntity = await deps.resolveTarget(toTarget)
    const result = await client.forwardMessages(toEntity, {
      messages: [msgId],
      fromPeer: fromEntity,
    })
    const first = Array.isArray(result) ? result[0] : undefined
    return { providerMessageId: first?.id != null ? String(first.id) : null }
  } catch (err) {
    deps.tripFloodCooldown(err)
    throw err
  }
}
