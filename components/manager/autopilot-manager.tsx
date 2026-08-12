'use client'

import { Bot, MessageSquareDot, Plus } from 'lucide-react'
import type { AutopilotSource } from '@/app/actions/autopilot'
import type { AutopilotRule } from '@/lib/autopilot/match'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { EmptyState } from '@/components/page-parts'
import { cn } from '@/lib/utils'
import { draftFromRule, emptyDraft } from './autopilot/draft'
import { RuleCard } from './autopilot/rule-card'
import { RuleEditor } from './autopilot/rule-editor'
import { useAutopilot } from './autopilot/use-autopilot'

export function AutopilotManager({
  initialEnabled,
  initialRules,
  sources,
}: {
  initialEnabled: boolean
  initialRules: AutopilotRule[]
  sources: AutopilotSource[]
}) {
  const {
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
  } = useAutopilot(initialEnabled, initialRules)

  return (
    <div className="flex flex-col gap-4">
      {/* Master switch */}
      <Card className="p-4 sm:p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-lg border',
                enabled
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border bg-muted/40 text-muted-foreground',
              )}
            >
              <Bot className="size-4" />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold">Автопилот</span>
              <span className="text-xs text-muted-foreground">
                {enabled
                  ? `Включён · активных правил: ${enabledCount}`
                  : 'Выключен — автоответы не отправляются'}
              </span>
            </div>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={toggleMaster}
            aria-label="Включить автопилот"
          />
        </div>
      </Card>

      {/* Create */}
      <Card className="p-4 sm:p-5">
        {creating ? (
          <RuleEditor
            initial={emptyDraft()}
            sources={sources}
            busy={pending}
            submitLabel="Создать"
            onSubmit={create}
            onCancel={() => setCreating(false)}
          />
        ) : (
          <Button
            type="button"
            variant="outline"
            className="w-full justify-center border-dashed"
            onClick={() => {
              setCreating(true)
              setEditingId(null)
            }}
          >
            <Plus className="size-4" />
            Добавить правило
          </Button>
        )}
      </Card>

      {/* List */}
      {rules.length === 0 && !creating ? (
        <Card className="p-8">
          <EmptyState
            icon={MessageSquareDot}
            title="Пока нет правил"
            description="Создайте правило, чтобы автопилот отвечал на входящие автоматически — например, приветствовал новых клиентов или реагировал на ключевые слова."
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {rules.map((rule, i) => (
            <Card key={rule.id} className="overflow-hidden p-4">
              {editingId === rule.id ? (
                <RuleEditor
                  initial={draftFromRule(rule)}
                  sources={sources}
                  busy={pending}
                  submitLabel="Сохранить"
                  onSubmit={(draft) => update(rule.id, draft)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <RuleCard
                  rule={rule}
                  index={i}
                  total={rules.length}
                  sources={sources}
                  pending={pending}
                  onMove={move}
                  onToggle={toggleRule}
                  onEdit={(id) => {
                    setEditingId(id)
                    setCreating(false)
                  }}
                  onRemove={remove}
                />
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
