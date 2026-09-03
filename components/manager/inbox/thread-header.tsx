'use client'

import {
  ArrowLeft,
  BrainCircuit,
  Info,
  MoreVertical,
  Search,
  UserPlus,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ContextMenuRadioItem } from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { visitorTag } from '@/components/manager/inbox/visual'
import {
  ContactAvatar,
  PresenceBadge,
  SourceChip,
  StatusChip,
  StatusRadioItems,
} from '@/components/manager/inbox/atoms'
import { LeadCardPanel } from '@/components/manager/inbox/lead-card-panel'
import type { Conversation } from '@/lib/types'
import type { PresenceState } from '@/components/manager/inbox/visual'

/**
 * Header of the open thread: back button (mobile), contact identity (opens the
 * details drawer), the AI-lead toggle, lead card, status chip and the actions
 * dropdown. Extracted verbatim from inbox-view.tsx.
 */
export function ThreadHeader({
  active,
  activePresence,
  activeAiLed,
  transferred = false,
  curatorName,
  aiButtonPulse,
  statusPending,
  activeStatusValue,
  hasTransferTargets,
  onBack,
  onOpenDetails,
  onToggleDetails,
  onToggleAi,
  onChangeStatus,
  onOpenTransfer,
  onOpenSearch,
  onBrowseMedia,
}: {
  active: Conversation
  activePresence: PresenceState | null
  activeAiLed: boolean
  /** Лид передан куратору (миграция 151): у менеджера — только чтение. */
  transferred?: boolean
  /** Имя куратора для бейджа, когда transferred. */
  curatorName?: string
  aiButtonPulse: boolean
  statusPending: boolean
  activeStatusValue: string
  hasTransferTargets: boolean
  onBack: () => void
  onOpenDetails: () => void
  onToggleDetails: () => void
  onToggleAi: () => void
  onChangeStatus: (value: string) => void
  onOpenTransfer: () => void
  /** Открыть телеграм-стиль поиск по сообщениям диалога. */
  onOpenSearch: () => void
  /** Навигация по кружкам/фото диалога для прикрепления к карточке лида. */
  onBrowseMedia: (kind: 'video_note' | 'photo', leadCardId: string) => void
}) {
  // Telegram-диалоги дают числовой Telegram ID вместо телефона — раньше он
  // ошибочно подставлялся в поле «Телефон» карточки. Телефон — только из
  // WhatsApp; числовой telegram-handle идёт в отдельное поле Telegram ID.
  const phoneDefault =
    active.channelType === 'whatsapp' ? active.contactHandle : undefined
  const telegramIdDefault =
    active.channelType === 'telegram' && /^\d+$/.test(active.contactHandle)
      ? active.contactHandle
      : undefined
  return (
    <div className="flex h-14 items-center gap-3 border-b border-border px-3 sm:px-4">
      <Button
        variant="ghost"
        size="icon-sm"
        className="md:hidden"
        onClick={onBack}
        aria-label="Назад к списку"
      >
        <ArrowLeft className="size-4" />
      </Button>
      <button
        type="button"
        onClick={onOpenDetails}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        aria-label="Открыть данные о контакте"
      >
        <ContactAvatar
          name={active.contactName}
          channel={active.channelType}
          channelId={active.channelId}
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="flex items-center gap-2 truncate text-sm font-semibold">
            {active.contactName}
            {active.contactUsername ? (
              <span className="shrink-0 truncate text-xs font-normal text-muted-foreground">
                @{active.contactUsername}
              </span>
            ) : null}
            {visitorTag(active) ? (
              <span className="shrink-0 rounded bg-muted px-1 text-[11px] font-medium tabular-nums text-muted-foreground">
                {visitorTag(active)}
              </span>
            ) : null}
            {activePresence ? <PresenceBadge state={activePresence} /> : null}
            {transferred ? (
              <span className="shrink-0 rounded bg-primary/15 px-1.5 text-[11px] font-medium text-primary">
                {curatorName ? `Передан ${curatorName}` : 'Передан куратору'}
              </span>
            ) : null}
          </p>
          <div className="flex min-w-0 items-center gap-1.5">
            <SourceChip conversation={active} size="xs" />
          </div>
        </div>
      </button>

      <div className="flex items-center gap-1.5">
        {/* Диалог передан куратору — ИИ менеджера отключён и переключать его
            нельзя (curator_id гейт), поэтому кнопку скрываем. */}
        {transferred ? null : (
          <Button
            variant={activeAiLed ? 'default' : 'ghost'}
            size="sm"
            onClick={onToggleAi}
            disabled={statusPending}
            aria-pressed={activeAiLed}
            title={
              activeAiLed
                ? 'ИИ ведёт этот диалог. Нажмите, чтобы отключить и ответить самому.'
                : 'Включить ИИ: он проанализирует переписку и продолжит общение.'
            }
            className={cn(
              'gap-1.5',
              aiButtonPulse && 'animate-shake ring-2 ring-primary',
            )}
          >
            <BrainCircuit className="size-4" />
            <span className="hidden sm:inline">
              {activeAiLed ? 'ИИ ведёт' : 'ИИ'}
            </span>
          </Button>
        )}

        <LeadCardPanel
          conversationId={active.id}
          defaults={{
            fullName: active.contactName !== 'NULL' ? active.contactName : '',
            telegramUsername: active.contactUsername,
            phone: phoneDefault,
            telegramId: telegramIdDefault,
          }}
          onBrowseMedia={onBrowseMedia}
        />

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onOpenSearch}
          aria-label="Поиск по диалогу"
          title="Поиск по сообщениям диалога"
        >
          <Search className="size-4" />
        </Button>

        <StatusChip
          status={active.status}
          auto={!active.statusManual}
          className="hidden sm:inline-flex"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleDetails}
          aria-label="Данные о контакте"
          className="hidden md:inline-flex"
        >
          <Info className="size-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Действия с диалогом"
              >
                <MoreVertical className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>Статус лида</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={activeStatusValue}
              onValueChange={(v) => onChangeStatus(v ?? 'auto')}
            >
              <StatusRadioItems
                Item={
                  DropdownMenuRadioItem as unknown as typeof ContextMenuRadioItem
                }
              />
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onOpenDetails}>
              <Info className="size-4" />
              Данные и источник
            </DropdownMenuItem>
            {hasTransferTargets && !transferred ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onOpenTransfer}>
                  <UserPlus className="size-4" />
                  Передать менеджеру
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
