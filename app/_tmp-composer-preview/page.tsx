'use client'

// TEMPORARY verification harness for the redesigned composer — not part of
// the app, deleted before commit. Renders MessageComposer standalone (no
// auth/DB needed) so the new mobile layout can be screenshotted directly.

import { useState } from 'react'
import { MessageComposer } from '@/components/manager/inbox/message-composer'

export default function TmpComposerPreview() {
  const [channel, setChannel] = useState<'telegram' | 'whatsapp'>('telegram')
  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex gap-2 border-b border-border p-2">
        <button
          className="rounded bg-muted px-2 py-1 text-xs"
          onClick={() => setChannel('telegram')}
        >
          telegram
        </button>
        <button
          className="rounded bg-muted px-2 py-1 text-xs"
          onClick={() => setChannel('whatsapp')}
        >
          whatsapp
        </button>
      </div>
      <div className="flex-1" />
      <MessageComposer
        key={channel}
        conversationId="demo"
        channelType={channel}
        channelId="demo-channel"
        getInitialDraft={() => ''}
        onPersistDraft={() => {}}
        onSend={() => {}}
        onSendSticker={() => {}}
        onSendMediaFile={() => {}}
        onSendVoice={() => {}}
        onVoiceError={() => {}}
        onScheduleSend={() => {}}
        aiLed={false}
        onBlockedInteract={() => {}}
        onToggleAi={() => {}}
        statusPending={false}
        pending={false}
        quickReplies={[]}
        telemostEnabled={true}
        onStartMeeting={() => {}}
        meetingPending={false}
        replyActive={false}
        editing={null}
      />
    </div>
  )
}
