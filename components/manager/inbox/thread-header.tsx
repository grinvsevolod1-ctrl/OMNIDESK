'use client'

import {
  ArrowLeft,
  BrainCircuit,
  Info,
  MoreVertical,
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
}: {
  active: Conversation
  activePresence: PresenceState | null
  activeAiLed: boolean
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
}) {
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
          </p>
          <div className="flex min-w-0 items-center gap-1.5">
            <SourceChip conversation={active} size="xs" />
          </div>
        </div>
      </button>

      <div className="flex items-center gap-1.5">
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

        <LeadCardPanel
          conversationId={active.id}
          defaults={{
            fullName: active.contactName !== 'NULL' ? active.contactName : '',
            telegramUsername: active.contactUsername,
            phone:
              active.channelType === 'whatsapp' || active.channelType === 'telegram'
                ? active.contactHandle
                : undefined,
          }}
        />

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
            {hasTransferTargets ? (
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
