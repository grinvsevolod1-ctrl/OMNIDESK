'use client'

import { useCallback, useState } from 'react'
import dynamic from 'next/dynamic'
import {
  GraduationCap,
  Highlighter,
  MessagesSquare,
  ScrollText,
  Settings2,
} from 'lucide-react'
import type {
  AiAssistLesson,
  AiAssistSettings,
} from '@/lib/data/ai-assist'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SettingsTab } from '@/components/admin/ai-settings-tab'
import { TrainingTab } from '@/components/admin/ai-training-tab'
// Secondary tabs (enrollment / corrections / logs) each pull their own subtree
// and are hidden behind a tab click. Load them on demand so the default
// Settings/Training view doesn't bundle them into its initial chunk.
const tabLoading = () => (
  <div className="p-6 text-sm text-muted-foreground">Загрузка…</div>
)
const AiEnrollmentTab = dynamic(
  () =>
    import('@/components/admin/ai-enrollment-tab').then((m) => m.AiEnrollmentTab),
  { loading: tabLoading },
)
const AiCorrectionsTab = dynamic(
  () =>
    import('@/components/admin/ai-corrections-tab').then(
      (m) => m.AiCorrectionsTab,
    ),
  { loading: tabLoading },
)
const AiLogsTab = dynamic(
  () => import('@/components/admin/ai-logs-tab').then((m) => m.AiLogsTab),
  { loading: tabLoading },
)

interface Props {
  initialSettings: AiAssistSettings
  initialLessons: AiAssistLesson[]
  initialLessonCount: number
  configured: boolean
}

export function AiAssistAdmin({
  initialSettings,
  initialLessons,
  initialLessonCount,
  configured,
}: Props) {
  const [settings, setSettings] = useState(initialSettings)
  const [lessons, setLessons] = useState(initialLessons)
  const [lessonCount, setLessonCount] = useState(initialLessonCount)

  const patchSettings = useCallback((next: AiAssistSettings) => {
    setSettings(next)
  }, [])

  return (
    <div className="flex flex-col gap-4">
      {!configured ? (
        <Card className="border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-700 dark:text-amber-400">
          Ключ AI Gateway не найден в переменных окружения. ИИ-ответы работать не
          будут, пока не задан <code className="font-mono">AI_GATEWAY_API_KEY</code>.
          Настройки и обучение доступны и сохранятся заранее.
        </Card>
      ) : null}

      <Tabs defaultValue="settings" className="w-full">
        <TabsList>
          <TabsTrigger value="settings">
            <Settings2 className="size-4" />
            Настройки
          </TabsTrigger>
          <TabsTrigger value="training">
            <GraduationCap className="size-4" />
            Обучение
            {lessonCount > 0 ? (
              <Badge variant="secondary" className="ml-1.5">
                {lessonCount}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="dialogs">
            <MessagesSquare className="size-4" />
            Диалоги
          </TabsTrigger>
          <TabsTrigger value="corrections">
            <Highlighter className="size-4" />
            Правки
          </TabsTrigger>
          <TabsTrigger value="logs">
            <ScrollText className="size-4" />
            Логи
          </TabsTrigger>
        </TabsList>

        <TabsContent value="settings" className="mt-4">
          <SettingsTab settings={settings} onChange={patchSettings} />
        </TabsContent>

        <TabsContent value="training" className="mt-4">
          <TrainingTab
            lessons={lessons}
            onLessonsChange={(next) => {
              setLessons(next)
              setLessonCount(next.length)
            }}
          />
        </TabsContent>

        <TabsContent value="dialogs" className="mt-4">
          <AiEnrollmentTab />
        </TabsContent>

        <TabsContent value="corrections" className="mt-4">
          <AiCorrectionsTab />
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <AiLogsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

