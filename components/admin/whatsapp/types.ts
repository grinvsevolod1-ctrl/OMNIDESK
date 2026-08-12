/**
 * Shared types for the WhatsApp admin section (components/admin/whatsapp/).
 * Kept in one place so the config card, numbers card and dialogs cannot
 * drift apart on the shape of the server-provided data.
 */

export const UNASSIGNED = 'unassigned'

export interface WhatsappAppStatus {
  configured: boolean
  webhookReady: boolean
  hasAppSecret: boolean
  verifyToken: string | null
  wabaId: string | null
  tokenMask: string | null
}

export interface WhatsappNumber {
  id: string
  managerId: string | null
  managerName: string | null
  name: string
  phoneNumberId: string
  displayPhoneNumber: string
  status: 'connected' | 'pending' | 'disconnected' | 'error'
  createdAt: string
}

export interface ImportCandidate {
  phoneNumberId: string
  displayPhoneNumber: string
  verifiedName: string
}
