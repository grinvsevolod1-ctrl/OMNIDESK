'use client'

/**
 * WhatsApp admin section — thin container. The actual UI lives in
 * components/admin/whatsapp/ (one file per card, shared types in types.ts),
 * mirroring the container+parts convention used by all-leads-section /
 * widget-editor-tabs / create-account-card.
 */

import type { Manager } from '@/lib/types'
import { AppConfigCard } from './whatsapp/app-config-card'
import { NumbersCard } from './whatsapp/numbers-card'
import type { WhatsappAppStatus, WhatsappNumber } from './whatsapp/types'

export function WhatsappAdmin({
  status,
  numbers,
  managers,
  callbackUrl,
  baseUrlError,
}: {
  status: WhatsappAppStatus
  numbers: WhatsappNumber[]
  managers: Manager[]
  callbackUrl: string
  baseUrlError: string | null
}) {
  return (
    <div className="flex flex-col gap-6">
      <AppConfigCard
        status={status}
        callbackUrl={callbackUrl}
        baseUrlError={baseUrlError}
      />
      <NumbersCard status={status} numbers={numbers} managers={managers} />
    </div>
  )
}
